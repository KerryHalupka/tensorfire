function TensorProgram(shader, out, uniforms){
    out.compile(shader, uniforms)
    return {
        output: out,
        run(options, callback){
            out.run(shader, uniforms, callback)
        },
        destroy(){
            out.destroy()
            for(let param in uniforms){
                if(uniforms[param] instanceof Tensor){
                    uniforms[param].destroy()
                }
            }
        }
    }
}

function makeOutput(gl, layer, shape){
  return new OutputTensor(gl, shape, getFormat(layer));
}

function makeTensor(gl, layer, data){
  // return new Tensor(gl, data)
  
  return new Tensor(gl, data, {
    type: 'uint8',
    pack: 'stride',
    density: '4:4',
    codec: 'linquant',
    min: ndops.inf(data),
    max: ndops.sup(data)
  });
  // return {type: "uint8", pack: "stride", density: "4:4", codec: "linquant", min: stats.min, max: stats.max }
}

function InputLayer(gl, layer, deps, options){
    if(!options[layer.name]) throw new Error("Invalid input");
    var tensor = new OutputTensor(gl, options[layer.name]);
    return {
        output: tensor,
        run(options, callback){
            if(options[layer.name]){
                tensor.update(options[layer.name])    
            }
            if(callback) callback();
        },
        destroy(){
            tensor.destroy()
        }
    }
}

function getFormat(layer){
    return undefined
}

function ComputeMean(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        const ivec2 tileSize = #(image.shape).xy;

        vec4 process4(ivec4 pos) {
            vec4 sum = vec4(0, 0, 0, 0);
            for(int x = 0; x < tileSize.x; x++){
                for(int y = 0; y < tileSize.y; y++){
                    sum += image.read4(ivec4(x, y, pos.z, 0));
                }
            }
            return sum / float(tileSize.x * tileSize.y);
        }
    `
    var meanTensor = makeOutput(gl, layer, [1, 1, deps.image.shape[2]])
    
    return TensorProgram(SHADER, meanTensor, {
        image: deps.image,
        _activation: layer.activation
    })
}


function ExpSum(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;

        vec4 process4(ivec4 pos) {
            vec4 sumVal = vec4(0);
            for(int i = 0; i < #(image.shape).z; i+=4){
                sumVal += exp(image.read4(ivec4(0, 0, i, 0)));
            }
            return vec4(dot(sumVal, vec4(1)));
        }
    `
    console.assert(deps.image.shape[0] == 1)
    console.assert(deps.image.shape[1] == 1)
    console.assert(deps.image.shape[3] == 1)
    var softmaxHelper = makeOutput(gl, layer, [1, 1, 4])
    return TensorProgram(SHADER, softmaxHelper, {
        image: deps.image
    })
}


function Softmax(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor helper;

        vec4 process4(ivec4 pos) {
            return exp(image.read4(pos)) / helper.read4(ivec4(0));
        }
    `
    console.assert(deps.helper.shape[0] == 1)
    console.assert(deps.helper.shape[1] == 1)
    console.assert(deps.helper.shape[2] == 4)
    console.assert(deps.helper.shape[3] == 1)

    var output = makeOutput(gl, layer, deps.image.shape)

    return TensorProgram(SHADER, output, {
        image: deps.image,
        helper: deps.helper,
    })
}


function Sum(gl, layer, deps){
    const SHADER = `
        uniform Tensor a;
        uniform Tensor b;

        vec4 process4(ivec4 pos) {
            return a.read4(pos) + b.read4(pos);
        }
    `
    if(deps.a.shape.some((k, i) => k != deps.b.shape[i]))
        throw new Error('Mismatched shapes for sum');

    var output = makeOutput(gl, layer, deps.a.shape)
    return TensorProgram(SHADER, output, {
        a: deps.a,
        b: deps.b,
        _activation: layer.activation
    })
}

function ZeroPadding2D(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform ivec2 padding;

        vec4 process4(ivec4 pos) {
            if(pos.x < padding.x || pos.y < padding.y){
                return vec4(0, 0, 0, 0);
            }else if(pos.x >= image.shape.x + padding.x 
                || pos.y >= image.shape.x + padding.y){
                return vec4(0, 0, 0, 0);
            }else{
                return image.read4(ivec4(pos.xy - padding.xy, pos.zw));    
            }
        }
    `
    if(layer.padding.length == 2){
        var padding = [
            layer.padding[0], layer.padding[0], 
            layer.padding[1], layer.padding[1]
        ];
    }else if(layer.padding.length == 4){
        var padding = layer.padding;
    }else{
        throw new Error('invalid padding length')
    }
    var output = makeOutput(gl, layer, [
        deps.image.shape[0] + padding[0] + padding[1],
        deps.image.shape[1] + padding[2] + padding[3],
        deps.image.shape[2],
        deps.image.shape[3]])
    return TensorProgram(SHADER, output, {
        image: deps.image,
        padding: layer.padding,
        _activation: layer.activation
    })
}

function Activation(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;

        vec4 process4(ivec4 pos) {
            return image.read4(pos);
        }
    `
    console.assert(['tanh', 'relu'].includes(layer.activation))
    var output = makeOutput(gl, layer, deps.image.shape)
    return TensorProgram(SHADER, output, {
        image: deps.image,
        _activation: layer.activation
    })
}


function unsqueeze (a, axis) {
    var shape, stride

    if (axis !== undefined && (!Number.isFinite(axis) || (axis % 1 !== axis))) {
        throw new Error('axis of dimension to unsqueeze must be an integer')
    }
    axis = axis === undefined ? a.shape.length : axis

    shape = a.shape.slice(0)
    stride = a.stride.slice(0)
    shape.splice(axis || 0, 0, 1)
    stride.splice(axis || 0, 0, (stride[axis] || 1) * (shape[axis + 1] || 1))

    return ndarray(a.data, shape, stride, a.offset)
}

function ChannelFullyConnected(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor weights;
        uniform Tensor bias;

        vec4 process4(ivec4 pos) {
            vec4 sum = bias.read4(ivec4(0, 0, pos.z, 0));

            for(int f = 0; f < #(image.shape).z; f += 4){
                vec4 inputPix = image.read4(ivec4(0, 0, f, 0));

                sum += inputPix.r * weights.read4(ivec4(0, 0, pos.z, f + 0))
                     + inputPix.g * weights.read4(ivec4(0, 0, pos.z, f + 1))
                     + inputPix.b * weights.read4(ivec4(0, 0, pos.z, f + 2))
                     + inputPix.a * weights.read4(ivec4(0, 0, pos.z, f + 3));
            }
            return sum;
        }
    `

    console.assert(deps.image.shape[0] == 1)
    console.assert(deps.image.shape[1] == 1)
    console.assert(deps.image.shape[3] == 1)
    console.assert(deps.image.shape[2] == layer.weights.shape[0])

    var bias = makeTensor(gl, layer, unsqueeze(unsqueeze(layer.bias, 0), 0))


    console.assert(bias.shape[0] == 1)
    console.assert(bias.shape[1] == 1)
    console.assert(bias.shape[2] == layer.weights.shape[1])
        // [ 1, 1, layer.bias ])


    var weights = makeTensor(gl, layer, unsqueeze(unsqueeze(layer.weights.transpose(1, 0), 0), 0))
        // [ 1, 1, layer.weights.shape[1], layer.weights.shape[0] ])

    console.assert(weights.shape[0] == 1)
    console.assert(weights.shape[1] == 1)
    console.assert(weights.shape[2] == layer.weights.shape[1])
    console.assert(weights.shape[3] == layer.weights.shape[0])

    var output = makeOutput(gl, layer, [1, 1, layer.weights.shape[1]])

    return TensorProgram(SHADER, output, {
        image: deps.image,
        weights: weights,
        bias: bias,
        _activation: layer.activation
    })
}





function Deconvolve2D(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor kernel;

        uniform ivec2 imagePadding;
        uniform ivec2 imageSubsample;

        const ivec2 kernelTileSize = #(kernel.shape).xy;

        vec4 process4(ivec4 pos){
            vec4 sum = vec4(0, 0, 0, 0);

            for(int f = 0; f < #(image.shape).z; f += 4){
                for(int kx = 0; kx < kernelTileSize.x; kx++){
                    int inputX = pos.x + kx - imagePadding.x;
                    if(imod(inputX, 2) != 0 || inputX < 0 || inputX >= int(image.shape.x) * 2) continue;

                    for(int ky = 0; ky < kernelTileSize.y; ky++){
                        int inputY = pos.y + ky - imagePadding.y;
                        if(imod(inputY, 2) != 0 || inputY < 0 || inputY >= int(image.shape.y) * 2) continue;

                        vec4 inputPix = image.read4(ivec4(inputX / 2, inputY / 2, f, 0));

                        sum += inputPix.r * kernel.read4(ivec4(kx, ky, pos.z, f + 0))
                             + inputPix.g * kernel.read4(ivec4(kx, ky, pos.z, f + 1))
                             + inputPix.b * kernel.read4(ivec4(kx, ky, pos.z, f + 2))
                             + inputPix.a * kernel.read4(ivec4(kx, ky, pos.z, f + 3));
                    }
                }
            }
            return sum;
        }
    `
    var kernelTensor = makeTensor(gl, layer, layer.kernel.transpose(0, 1, 3, 2).step(-1, -1))

    var outputShape = [
        deps.image.shape[0] * layer.subsample[0], 
        deps.image.shape[1] * layer.subsample[1], 
        kernelTensor.shape[2]
    ];

    var output = makeOutput(gl, layer, outputShape)
    return TensorProgram(SHADER, output, {
        image: deps.image,
        kernel: kernelTensor,
        imagePadding: layer.padding,
        imageSubsample: layer.subsample,
        _activation: layer.activation
    })
}

function SquaredResidual(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor mean;

        vec4 process4(ivec4 pos){
            vec4 tileMean = mean.read4(ivec4(0, 0, pos.z, 0));
            vec4 pix = image.read4(pos);
            return pow(pix - tileMean, vec4(2, 2, 2, 2));
        }
    `
    console.assert(deps.mean.shape[0] == 1)
    console.assert(deps.mean.shape[1] == 1)
    console.assert(deps.image.shape[2] == deps.mean.shape[2])

    var residualTensor = makeOutput(gl, layer, deps.image.shape)

    return TensorProgram(SHADER, residualTensor, {
        image: deps.image,
        mean: deps.mean,
        _activation: layer.activation
    })
}

function InstanceNormalize(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor mean;
        uniform Tensor variance;
        uniform Tensor beta;
        uniform Tensor gamma;

        const float eps = 0.00001;

        vec4 process4(ivec4 pos) {
            vec4 tileMean = mean.read4(ivec4(0, 0, pos.z, 0));
            vec4 tileStd = vec4(eps, eps, eps, eps) + sqrt(variance.read4(ivec4(0, 0, pos.z, 0)));
            vec4 tileBeta = beta.read4(ivec4(0, 0, pos.z, 0));
            vec4 tileGamma = gamma.read4(ivec4(0, 0, pos.z, 0));
            vec4 pix = image.read4(ivec4(pos.xyz, 0));
            return (pix - tileMean) / tileStd * tileGamma + tileBeta;
        }
    `

    var betaTensor = makeTensor(gl, layer, ndarray(layer.beta.data, [1, 1, layer.beta.size]));
    var gammaTensor = makeTensor(gl, layer, ndarray(layer.gamma.data, [1, 1, layer.gamma.size]));
    var normalizedTensor = makeOutput(gl, layer, deps.image.shape)
    
    return TensorProgram(SHADER, normalizedTensor, { 
        image: deps.image, 
        mean: deps.mean, 
        variance: deps.variance, 

        beta: betaTensor,
        gamma: gammaTensor,
        _activation: layer.activation
    })
}


function BatchNormalize(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor beta;
        uniform Tensor gamma;

        vec4 process4(ivec4 pos) {
            return (image.read4(ivec4(pos.xyz, 0)) + 
                beta.read4(ivec4(0, 0, pos.z, 0))) * 
                gamma.read4(ivec4(0, 0, pos.z, 0));
        }
    `


    console.assert(layer.beta.size == layer.gamma.size)
    console.assert(layer.beta.size == deps.image.shape[2])

    var beta = new Float32Array(layer.beta.size),
        gamma = new Float32Array(layer.gamma.size);

    for(var i = 0; i < layer.beta.size; i++){
        var std_gamma = Math.sqrt(layer.running_std.get(i) + layer.epsilon) / layer.gamma.get(i);
        gamma[i] = 1 / std_gamma
        beta[i] = -layer.running_mean.get(i) + layer.beta.get(i) * std_gamma;
    }

    // var gamma = 1 / (tileStd * tileGamma);
    // var beta = -tileMean + tileBeta * (tileStd * tileGamma)

    // (pix - tileMean + tileBeta * (tileStd * tileGamma)) / tileStd * tileGamma

    // (x - mean) / (std / gamma) + beta
    // (x - mean + beta * (std / gamma)) / (std / gamma)
    // (x + BETA) * GAMMA
    // BETA = - mean + beta * (std / gamma)
    // GAMMA = 1 / (std / gamma)

    var betaTensor = makeTensor(gl, layer, ndarray(beta, [1, 1, layer.beta.size]));
    var gammaTensor = makeTensor(gl, layer, ndarray(gamma, [1, 1, layer.gamma.size]));
    var normalizedTensor = makeOutput(gl, layer, deps.image.shape)

    return TensorProgram(SHADER, normalizedTensor, { 
        image: deps.image, 
        beta: betaTensor,
        gamma: gammaTensor,
        _activation: layer.activation
    })
}

// based on: https://github.com/transcranial/keras-js/blob/master/src/layers/convolutional/Convolution2D.js

function calcOutputShape(inputShape, kernelShape, subsample = [1, 1], borderMode = 'same') {
    const inputRows = inputShape[0]
    const inputCols = inputShape[1]
    const [nbRow, nbCol, inputChannels, outputChannels] = kernelShape

    const outputRows = borderMode === 'same'
      ? Math.floor((inputRows + subsample[0] - 1) / subsample[0])
      : Math.floor((inputRows - nbRow + subsample[0]) / subsample[0])
    const outputCols = borderMode === 'same'
      ? Math.floor((inputCols + subsample[1] - 1) / subsample[1])
      : Math.floor((inputCols - nbCol + subsample[1]) / subsample[1])

    const paddingRow = borderMode === 'same'
      ? Math.max(0, Math.floor((outputRows - 1) * subsample[0] + nbRow - inputRows))
      : 0
    const paddingCol = borderMode === 'same'
      ? Math.max(0, Math.floor((outputCols - 1) * subsample[1] + nbCol - inputCols))
      : 0
    const paddingRowBefore = Math.floor(paddingRow / 2)
    const paddingRowAfter = paddingRow - paddingRowBefore
    const paddingColBefore = Math.floor(paddingCol / 2)
    const paddingColAfter = paddingCol - paddingColBefore

    return {
        outputShape: [outputRows, outputCols, outputChannels],
        inputPadding: [paddingRowBefore, paddingColBefore]
    }
    // this.inputPadding = [paddingRowBefore, paddingRowAfter, paddingColBefore, paddingColAfter]
}

function Convolve2D(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor kernel;
        
        uniform ivec2 imagePadding;
        uniform ivec2 imageSubsample;

        const ivec2 kernelTileSize = #(kernel.shape).xy;

        vec4 process4(ivec4 pos){
            vec4 sum = vec4(0, 0, 0, 0);

            for(int f = 0; f < #(image.shape).z; f += 4){
                for(int kx = 0; kx < kernelTileSize.x; kx++){
                    int inputX = pos.x * imageSubsample.x + kx - imagePadding.x;
                    if(inputX < 0 || inputX >= int(image.shape.x)) continue;

                    for(int ky = 0; ky < kernelTileSize.y; ky++){
                        int inputY = pos.y  * imageSubsample.y + ky - imagePadding.y;
                        if(inputY < 0 || inputY >= int(image.shape.y)) continue;

                        vec4 inputPix = image.read4(ivec4(inputX, inputY, f, 0));
                        
                        sum += inputPix.r * kernel.read4(ivec4(kx, ky, pos.z, f + 0))
                             + inputPix.g * kernel.read4(ivec4(kx, ky, pos.z, f + 1))
                             + inputPix.b * kernel.read4(ivec4(kx, ky, pos.z, f + 2))
                             + inputPix.a * kernel.read4(ivec4(kx, ky, pos.z, f + 3));
                    }
                }
            }
            return sum;
        }
    `
    console.assert(layer.kernel.shape[2] == deps.image.shape[2])
    var kernelTensor = makeTensor(gl, layer, layer.kernel.transpose(0, 1, 3, 2))
    var { inputPadding, outputShape } = calcOutputShape(deps.image.shape, 
        [0, 1, 3, 2].map(k => kernelTensor.shape[k]), layer.subsample, layer.border_mode)
    var outputTensor = makeOutput(gl, layer, outputShape)

    return TensorProgram(SHADER, outputTensor, {
        kernel: kernelTensor,
        image: deps.image,

        imagePadding: inputPadding,
        imageSubsample: layer.subsample,
        _activation: layer.activation
    })
}


function BiasConvolve2D(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        uniform Tensor kernel;
        uniform Tensor bias;

        uniform ivec2 imagePadding;
        uniform ivec2 imageSubsample;

        const ivec2 kernelTileSize = #(kernel.shape).xy;

        vec4 process4(ivec4 pos){
            vec4 sum = bias.read4(ivec4(0, 0, pos.z, 0));

            for(int f = 0; f < #(image.shape).z; f += 4){
                for(int kx = 0; kx < kernelTileSize.x; kx++){
                    int inputX = pos.x * imageSubsample.x + kx - imagePadding.x;
                    if(inputX < 0 || inputX >= int(image.shape.x)) continue;

                    for(int ky = 0; ky < kernelTileSize.y; ky++){
                        int inputY = pos.y  * imageSubsample.y + ky - imagePadding.y;
                        if(inputY < 0 || inputY >= int(image.shape.y)) continue;

                        vec4 inputPix = image.read4(ivec4(inputX, inputY, f, 0));

                        sum += inputPix.r * kernel.read4(ivec4(kx, ky, pos.z, f + 0))
                             + inputPix.g * kernel.read4(ivec4(kx, ky, pos.z, f + 1))
                             + inputPix.b * kernel.read4(ivec4(kx, ky, pos.z, f + 2))
                             + inputPix.a * kernel.read4(ivec4(kx, ky, pos.z, f + 3));
                    }
                }
            }
            return sum;
        }
    `
    console.assert(layer.kernel.shape[2] == deps.image.shape[2])
    console.assert(layer.bias.shape[0] == layer.kernel.shape[3])

    var kernelTensor = makeTensor(gl, layer, layer.kernel.transpose(0, 1, 3, 2))
    var biasTensor = makeTensor(gl, layer, ndarray(layer.bias.data, [1, 1, layer.bias.size]));

    var { inputPadding, outputShape } = calcOutputShape(deps.image.shape, 
        [0, 1, 3, 2].map(k => kernelTensor.shape[k]), layer.subsample, layer.border_mode)
    var outputTensor = makeOutput(gl, layer, outputShape)

    return TensorProgram(SHADER, outputTensor, {
        kernel: kernelTensor,
        bias: biasTensor,
        image: deps.image,

        imagePadding: inputPadding,
        imageSubsample: layer.subsample,
        _activation: layer.activation
    })
}



function MaxPooling2D(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        
        uniform ivec2 strides;
        uniform ivec2 padding;

        const ivec2 pool_size = #(_pool_size);

        vec4 process4(ivec4 pos){
            vec4 value = vec4(-10000, -10000, -10000, -10000);
            for(int kx = 0; kx < pool_size.x; kx++){
                int inputX = pos.x * strides.x + kx - padding.x;
                if(inputX < 0 || inputX >= int(image.shape.x)) continue;
                for(int ky = 0; ky < pool_size.y; ky++){
                    int inputY = pos.y  * strides.y + ky - padding.y;
                    if(inputY < 0 || inputY >= int(image.shape.y)) continue;
                    value = max(value, image.read4(ivec4(inputX, inputY, pos.z, pos.w)));
                }
            }
            return value;
        }
    `


    var { inputPadding, outputShape } = calcOutputShape(deps.image.shape, 
        [ layer.pool_size[0], layer.pool_size[1], -1, deps.image.shape[2]], 
        layer.strides, layer.border_mode)


    var out = makeOutput(gl, layer, outputShape)
    return TensorProgram(SHADER, out, {
        image: deps.image,

        padding: inputPadding,
        _pool_size: layer.pool_size,
        strides: layer.strides,

        _activation: layer.activation
    })
}



function AveragePooling2D(gl, layer, deps){
    const SHADER = `
        uniform Tensor image;
        
        uniform ivec2 strides;
        uniform ivec2 padding;

        const ivec2 pool_size = #(_pool_size);

        vec4 process4(ivec4 pos){
            vec4 value = vec4(0, 0, 0, 0);
            for(int kx = 0; kx < pool_size.x; kx++){
                int inputX = pos.x * strides.x + kx - padding.x;
                if(inputX < 0 || inputX >= int(image.shape.x)) continue;
                for(int ky = 0; ky < pool_size.y; ky++){
                    int inputY = pos.y  * strides.y + ky - padding.y;
                    if(inputY < 0 || inputY >= int(image.shape.y)) continue;
                    value += image.read4(ivec4(inputX, inputY, pos.z, pos.w));
                }
            }
            return value / float(pool_size.x * pool_size.y);
        }
    `


    var { inputPadding, outputShape } = calcOutputShape(deps.image.shape, 
        [ layer.pool_size[0], layer.pool_size[1], -1, deps.image.shape[2]], 
        layer.strides, layer.border_mode)

    var out = makeOutput(gl, layer, outputShape)
    return TensorProgram(SHADER, out, {
        image: deps.image,

        padding: inputPadding,
        _pool_size: layer.pool_size,
        strides: layer.strides,

        _activation: layer.activation
    })
}


function ConcatChannel(gl, layer, deps){
    const SHADER = `
        uniform Tensor a;
        uniform Tensor b;

        vec4 process4(ivec4 pos) {
            if(pos.z < a.shape.z){
                return a.read4(pos);
            }else{
                return b.read4(ivec4(pos.xy, pos.z - a.shape.z, pos.w));
            }
        }
    `
    // the third channel must be divisible by 4 because
    // of the channel multiplexing stuff

    console.assert(deps.a.shape[2] % 4 == 0)
    console.assert(deps.b.shape[2] % 4 == 0)

    console.assert(deps.a.shape[0] == deps.b.shape[0])
    console.assert(deps.a.shape[1] == deps.b.shape[1])
    console.assert(deps.a.shape[3] == deps.b.shape[3])

    var output = makeOutput(gl, layer, [
        deps.a.shape[0], deps.a.shape[1], 
        deps.a.shape[2] + deps.b.shape[2],
        deps.a.shape[3]]);

    return TensorProgram(SHADER, output, {
        a: deps.a,
        b: deps.b,
        _activation: layer.activation
    })
}



const LAYER_TYPES = {
    InputLayer,
    ChannelFullyConnected,
    Convolve2D,
    BiasConvolve2D,
    Sum,
    ComputeMean,
    ExpSum,
    Softmax,
    MaxPooling2D,
    SquaredResidual,
    ZeroPadding2D,
    AveragePooling2D,
    InstanceNormalize,
    BatchNormalize,
    Activation,
    ConcatChannel,
    Deconvolve2D
}
