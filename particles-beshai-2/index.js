const regl = require('regl')({
	// need this to use the textures as states
  extensions: 'OES_texture_float',
})

const d3 = require('d3');


const width = window.innerWidth;
const height = window.innerHeight;
const pointWidth = 3;

const animationTickLimit = -1; // -1 disables
if (animationTickLimit >= 0) {
  console.log(`Limiting to ${animationTickLimit} ticks`);
}

const ticksPerFlow = 30;
console.log(`Changing flow buffer every ${ticksPerFlow} ticks`);

const sqrtNumParticles = 256;
const numParticles = sqrtNumParticles * sqrtNumParticles;
console.log(`Using ${numParticles} particles`);

// initialize regl
// const regl = createREGL();


// initial particles state and texture for buffer
// multiply by 4 for R G B A
const initialParticleState = new Float32Array(numParticles * 4);
for (let i = 0; i < numParticles; ++i) {
	// store x then y then tick lifespan and 1 empty spot
	initialParticleState[i * 4] = 2 * Math.random() - 1; // x position
	initialParticleState[i * 4 + 1] = 2 * Math.random() - 1; // y position
	initialParticleState[i * 4 + 2] = 50 + 1000 * Math.random(); // tick lifespan position
}

// create a regl framebuffer holding the initial particle state
function createInitialParticleBuffer(initialParticleState) {
	// create a texture where R holds particle X and G holds particle Y position
	const initialTexture = regl.texture({
	  data: initialParticleState,
	  shape: [sqrtNumParticles, sqrtNumParticles, 4],
	  type: 'float'
	});

	// create a frame buffer using the state as the colored texture
	return regl.framebuffer({
		color: initialTexture,
		depth: false,
		stencil: false,
	});
}

// initialize particle states
let prevParticleState = createInitialParticleBuffer(initialParticleState);
let currParticleState = createInitialParticleBuffer(initialParticleState);
let nextParticleState = createInitialParticleBuffer(initialParticleState);

// cycle which buffer is being pointed to by the state variables
function cycleParticleStates() {
	const tmp = prevParticleState;
	prevParticleState = currParticleState;
	currParticleState = nextParticleState;
	nextParticleState = tmp;
}

// create array of indices into the particle texture for each particle
const particleTextureIndex = [];
for (let i = 0; i < sqrtNumParticles; i++) {
	for (let j = 0; j < sqrtNumParticles; j++) {
		particleTextureIndex.push(i / sqrtNumParticles, j / sqrtNumParticles);
	}
}

// helper to normalize a vector of length 2 so it has magnitude 1 (mutates)
function normalize(vector) {
	const magnitude = Math.sqrt(Math.pow(vector[0], 2) + Math.pow(vector[1], 2));
	vector[0] /= magnitude;
	vector[1] /= magnitude;
	return vector;
}

// create the flow map
const sqrtFlowDataLength = 4;
const numFlowData = sqrtFlowDataLength * sqrtFlowDataLength;
const flowData = [];

// generate a mesh for a grid
function makeGridMesh(numCols, numRows) {

  // helper scales to map to normalized device coordinates from columns for simplicity
  const colScale = d3.scaleLinear().domain([0, numCols - 1]).range([-1, 1]);
  const rowScale = d3.scaleLinear().domain([0, numRows - 1]).range([1, -1]);

  // at this point, we are going to create a grid mesh so we can interpolate
  // between the values of our flow so they smoothly merge into one another.
  // if you uncomment drawFlowBuffer() in the regl.frame code way below
  // you can see what the flow buffer looks like.

  // create vertices for each flow data point
  const vertices = d3.range(numFlowData).map((i) => {
    const col = i % numCols;
    const row = Math.floor(i / numCols);

    return [colScale(col), rowScale(row)];
  });

  // helper to find an index in the flat array based on row an doclumn
  const indexAtColRow = (col, row) => col + (row * numCols);

  // create the faces for the mesh (two triangles form a grid cell)
  const faces = [];
  vertices.forEach((vertex, i) => {
    const col = i % numCols;
    const row = Math.floor(i / numCols);

    if (col + 1 < numCols && row + 1 < numRows) {
      const topLeftTriangle = [i, i + 1, indexAtColRow(col, row + 1)];
      faces.push(topLeftTriangle);
    }

    if (col + 1 < numCols && row - 1 >= 0) {
      const bottomLeftTriangle = [i, i + 1, indexAtColRow(col + 1, row - 1)];
      faces.push(bottomLeftTriangle);
    }
  });

  return { positions: vertices, cells: faces };
}
const gridMesh = makeGridMesh(sqrtFlowDataLength, sqrtFlowDataLength);

// generate a new flow map by updating values in flowData
function generateFlowData() {
	d3.range(numFlowData).forEach((i) => {
	  flowData[i] = normalize([
      Math.random() * 2 - 1, // column
      Math.random() * 2 - 1, // row
      3 * Math.random(), // magnitude
    ]);
	});
}

// generate the initial flow mesh
generateFlowData();

// how high res we want the smoothed flow map to look
// turn on drawFlowBuffer() in regl.frame to see the difference
const upscaleAmount = sqrtFlowDataLength * 16;

const flowBuffer = regl.framebuffer({
	color: regl.texture({
    // initialize to empty values
		data: new Float32Array(upscaleAmount * upscaleAmount * 4),
		shape: [upscaleAmount, upscaleAmount, 4],
		type: 'float',
	}),
	depth: false,
	stencil: false,
});


// regl command to populate the flowBuffer with actual values based on our data
// uses the grid mesh to interpolate the flow values at each point in the grid
const generateFlowBuffer = regl({
	framebuffer: flowBuffer,
  vert: `
  precision mediump float;

  attribute vec2 position;
  attribute vec3 flowData;

  varying vec3 flow;

  void main() {
    flow = flowData;
    gl_Position = vec4(position, 0, 1);
  }`,

  frag: `
  precision mediump float;

  varying vec3 flow;

  void main() {
    gl_FragColor = vec4(flow, 1);
  }`,

  // this converts the vertices of the mesh into the position attribute
  attributes: {
    position: gridMesh.positions,
    flowData: () => flowData,
  },

  elements: gridMesh.cells,
})


const drawFlowBuffer = regl({
	vert: `
	// set the precision of floating point numbers
  precision mediump float;

  // vertex of the triangle
  attribute vec2 vertex;

  // index into the texture state
  varying vec2 flowIndex;

  void main() {
  	// map bottom left -1,-1 (normalized device coords) to 0,0 (particle texture index)
  	// and 1,1 (ndc) to 1,1 (texture)
  	flowIndex = 0.5 * (1.0 + vertex);

  	gl_Position = vec4(vertex, 0, 1);
  }
	`,

  frag: `
  // set the precision of floating point numbers
  precision mediump float;

  uniform sampler2D flowBuffer;

  // index into the texture state
  varying vec2 flowIndex;

  void main() {
    vec3 flow = texture2D(flowBuffer, flowIndex).xyz;
    gl_FragColor = vec4(flow, 1);
  }
  `,

	attributes: {
		// a triangle big enough to fill the screen
    vertex: [
      -4, 0,
      4, 4,
      4, -4
    ]
  },

  // pass in previous states to work from
  uniforms: {
    flowBuffer,
  },

  // it's a triangle - 3 vertices
  count: 3,
});

// regl command that updates particles state based on previous two
const updateParticles = regl({
	// write to a framebuffer instead of to the screen
  framebuffer: () => nextParticleState,
  // ^^^^^ important stuff.  ------------------------------------------

	vert: `
	// set the precision of floating point numbers
  precision mediump float;

  // vertex of the triangle
  attribute vec2 vertex;

  // index into the texture state
  varying vec2 particleTextureIndex;
	uniform sampler2D flowBuffer;

  void main() {
  	// map bottom left -1,-1 (normalized device coords) to 0,0 (particle texture index)
  	// and 1,1 (ndc) to 1,1 (texture)
  	particleTextureIndex = 0.5 * (1.0 + vertex);

  	gl_Position = vec4(vertex, 0, 1);
  }
	`,

  // since we are writing to a framebuffer, all our data needs to be encoded
  // as the rgb value, hence why the frag shader is where all the work happens.
  frag: `
  // set the precision of floating point numbers
  precision mediump float;

  // states to read from to get velocity
  uniform sampler2D currParticleState;
  uniform sampler2D prevParticleState;

  uniform sampler2D flowBuffer;
  uniform float tick;

  // index into the texture state
  varying vec2 particleTextureIndex;

  // seemingly standard 1-liner random function
  // http://stackoverflow.com/questions/4200224/random-noise-functions-for-glsl
  float rand(vec2 co){
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 particle = texture2D(currParticleState, particleTextureIndex).xyz;
    vec2 currPosition = particle.xy;
    float tickLifespan = particle[2];

    vec3 prevParticle = texture2D(prevParticleState, particleTextureIndex).xyz;
    vec2 prevPosition = prevParticle.xy;
    float prevTickLifespan = prevParticle[2];

    vec2 position;

    // respawn
    if (tickLifespan <= -1.0) {
      tickLifespan = 100.0 * rand(tick * particleTextureIndex) + 1.0;
      position = 2.0 * vec2(rand(tick * position), rand(tick * tickLifespan * position)) - 1.0;

    // update current position
    } else {

      // find flow based on current position
      vec2 flowIndex = 0.5 * (currPosition + 1.0);
      vec3 flow = texture2D(flowBuffer, flowIndex).xyz;
      float flowMagnitude = flow[2];

      vec2 velocity;

      // use velocity unless just respawned
      if (tickLifespan != prevTickLifespan - 1.0) {
        velocity = vec2(0.0);
      } else {
        velocity = currPosition - prevPosition;
      }

      vec2 random = 0.5 - vec2(rand(currPosition), rand(10.0 * currPosition));
      // random = vec2(0.0, 0.0);

      position = currPosition +
        (0.96 * velocity) +
        (0.001 * random) +
        (flow.xy * (flowMagnitude * 0.0002));
    }

    // we store the new position as the color in this frame buffer
    // reduce the tick lifespan by 1
    gl_FragColor = vec4(position, tickLifespan - 1.0, 1);
  }
  `,

	attributes: {
		// a triangle big enough to fill the screen
    vertex: [
      -4, 0,
      4, 4,
      4, -4
    ]
  },

  // pass in previous states to work from
  uniforms: {
  	// must use a function so it gets updated each call
    currParticleState: () => currParticleState,
    prevParticleState: () => prevParticleState,
    flowBuffer,

    // include tick for improving randoms
    tick: ({ tick }) => tick,
  },

  // it's a triangle - 3 vertices
  count: 3,
});

// regl command that draws particles at their current state
const drawParticles = regl({
	vert: `
	// set the precision of floating point numbers
  precision mediump float;

	attribute vec2 particleTextureIndex;
	uniform sampler2D currParticleState;
	uniform sampler2D prevParticleState;
	uniform sampler2D flowBuffer;

  // variables to send to the fragment shader
  varying vec3 fragColor;

  // values that are the same for all vertices
  uniform float pointWidth;

  // get color based on particle speed
  vec3 getColor(vec3 currParticle, vec3 prevParticle) {
  	vec2 currPosition = currParticle.xy;
		float tickLifespan = currParticle[2];
		vec2 prevPosition = prevParticle.xy;
		float prevTickLifespan = prevParticle[2];

		vec2 velocity;

  	// use velocity unless just respawned
		if (tickLifespan != prevTickLifespan - 1.0) {
			velocity = vec2(0.0);
		} else {
			velocity = currPosition - prevPosition;
		}

    // color based on the speed (faster particles are brighter)
		float speed = sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1]);

    // color scale going from color0 -> color1 -> color2 -> color3
    vec3 color0 = vec3(0.0, 0.0, 0.2);
    vec3 color1 = vec3(0.0, 0.0, 0.35);
    vec3 color2 = vec3(0.8, 0.3, 0.4);
    vec3 color3 = vec3(1.0, 0.9, 0.6);

    float break0 = 0.0;
    float break1 = 0.001;
    float break2 = 0.027;
    float break3 = 0.04;

    if (speed < break1) {
      float t = (speed - break0) / break1;
      return mix(color0, color1, t);
    } else if (speed < break2) {
      float t = (speed - break1) / break2;
      // float t = (speed - 0.001) / 0.03;
      return mix(color1, color2, t);
    } else  {
      float t = (speed - break2) / break3;
      return mix(color2, color3, min(1.0, t));
    }
  }

	void main() {
		// read in position from the state texture
		vec3 currParticle = texture2D(currParticleState, particleTextureIndex).xyz;
		vec2 currPosition = currParticle.xy;

		vec3 prevParticle = texture2D(prevParticleState, particleTextureIndex).xyz;

		// copy color over to fragment shader
		fragColor = getColor(currParticle, prevParticle);

		// scale to normalized device coordinates
		// gl_Position is a special variable that holds the position of a vertex
    gl_Position = vec4(currPosition, 0.0, 1.0);

		// update the size of a particles based on the prop pointWidth
		gl_PointSize = pointWidth;
	}
	`,

  frag: `
  // set the precision of floating point numbers
  precision mediump float;

  // this value is populated by the vertex shader
  varying vec3 fragColor;

  void main() {
    // gl_FragColor is a special variable that holds the color of a pixel
    gl_FragColor = vec4(fragColor, 1);
  }
  `,

	attributes: {
		// each of these gets mapped to a single entry for each of the points.
		// this means the vertex shader will receive just the relevant value for a given point.
		particleTextureIndex,
	},

	uniforms: {
		// important to use a function here so it gets the new buffer each render
		currParticleState: () => currParticleState,
		prevParticleState: () => prevParticleState,
		pointWidth,
		flowBuffer,
	},

	// specify the number of points to draw
	count: numParticles,

	// specify that each vertex is a point (not part of a mesh)
	primitive: 'points',

	// we don't care about depth computations
	depth: {
	  enable: false,
	  mask: false,
	},
});

// start the animation loop
const frameLoop = regl.frame(({ tick }) => {
	// clear the buffer
	regl.clear({
		// background color (black)
		color: [0, 0, 0, 1],
		depth: 1,
		stencil: 0,
	});

  // generate new flow every ticksPerFlow ticks
	if (tick === 1 || tick % ticksPerFlow === 0) {
		generateFlowData();
		generateFlowBuffer();
	}

  // uncomment below to see the flow buffer
	// drawFlowBuffer();

	// draw the points using our created regl func
	drawParticles();

	// update position of particles in state buffers
	updateParticles();

	// update pointers for next, current, and previous particle states
	cycleParticleStates();

	// simple way of stopping the animation after a few ticks
	if (tick === animationTickLimit) {
		console.log(`Hit tick ${tick}, canceling animation loop`);

		// cancel this loop
		frameLoop.cancel();
	}
});