import assert from 'assert'
import { Tensor, OutputTensor, InPlaceTensor, Run, Compile } from '../src/index.js'
import headlessGL from "gl"
import ndt from 'ndarray-tests'
import ndpack from 'ndarray-pack'
import ndunpack from 'ndarray-unpack'
import ndshow from 'ndarray-show'
import ndarray from 'ndarray'

function assEqual(a, b){
	if(ndt.equal(a, b, 1e-5)){

	}else{
		throw new Error('Unequal NDArrays\nFound: \n' + ndshow(a) + '\nExpected: \n' + ndshow(b))
	}
}


const IDENTITY = `
	uniform Tensor image;

	vec4 process4(ivec4 pos){
		return image.read4(pos);
	}
`;


describe('Activations', () => {
	var gl = headlessGL(100, 100, { preserveDrawingBuffer: true })

	
	it('throw with invalid activation', () => {
		var arr = ndpack([
			[5, 6], 
			[-3, 0]]),
			inp = new Tensor(gl, arr),
			out = new OutputTensor(gl, inp.shape);
		
		assert.throws(() => Run(IDENTITY, out, { image: inp, _activation: 'wumbo' }))
	})

	it('linear', () => {
		var arr = ndpack([
			[5, 6], 
			[-3, 0],
			[53, 4], 
			[-1, 0]]),
			inp = new Tensor(gl, arr),
			out = new OutputTensor(gl, inp.shape);
		Run(IDENTITY, out, { image: inp, _activation: 'linear' })
		assEqual(out.read(), arr)
	})


	it('relu', () => {
		var inp = new Tensor(gl, ndpack([
			[5, 6], 
			[-3, 0],
			[1, 2],
			[-1, 0]])),
			out = new OutputTensor(gl, inp.shape);
		Run(IDENTITY, out, { image: inp, _activation: 'relu' })
		assEqual(out.read(), ndpack([
			[5, 6],
			[0, 0],
			[1, 2],
			[0, 0]]))
	})
	
	it('should work', () => {
		var inp = new Tensor(gl, ndpack([
			[53, 3], 
			[-32, 0]])),
			out = new OutputTensor(gl, inp.shape);
		Run(IDENTITY, out, { image: inp, _activation: 'sigmoid' })
		assEqual(out.read(), ndpack([
			[1, 0.9975274205207825],
			[0, 0.5]]))
	})

	it('tanh', () => {
		var inp = new Tensor(gl, ndpack([
			[53, 3], 
			[-32, 0]])),
			out = new OutputTensor(gl, inp.shape);
		Run(IDENTITY, out, { image: inp, _activation: 'tanh' })

		assEqual(out.read(), ndpack([
			[1, 0.9950547814369202],
			[-1, 0]]))
	})


})
