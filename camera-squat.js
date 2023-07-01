/**
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
import * as posenet from '@tensorflow-models/posenet';
import dat from 'dat.gui';
import Stats from 'stats.js';
// eslint-disable-next-line max-len
import {drawKeypoints, drawSkeleton, drawBoundingBox, drawPoint} from './demo_util';

// eslint-disable-next-line one-var
const videoWidth = isMobile() ? 600*0.5 : 720,
      videoHeight = isMobile() ? 500*0.5 : 600,
      stats = new Stats(),
      minimumPartConfidence = 0.3,
    // eslint-disable-next-line no-unused-vars
      rightShoulderKeypointIndex = 6;

// eslint-disable-next-line one-var
let calibrationExecutedForStandingPose = false,
    calibrationContinue = false,
    calibrationPoints = new Map(),
    cycles = new Map(),
    fullCyclesCounted = 0;


let poses = [];

// const widthWindow = window.innerWidth
//     || document.documentElement.clientWidth
//     || document.body.clientWidth;

function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

function isiOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isMobile() {
  return isAndroid() || isiOS();
}

/**
 * Loads a the camera to be used in the demo
 *
 */
async function setupCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
        'Browser API navigator.mediaDevices.getUserMedia not available');
  }

  const video = document.getElementById('video');
  video.width = videoWidth;
  video.height = videoHeight;

  const mobile = isMobile();
  const stream = await navigator.mediaDevices.getUserMedia({
    'audio': false,
    'video': {
      facingMode: 'user',
      width: mobile ? undefined : videoWidth,
      height: mobile ? undefined : videoHeight,
    },
  });
  video.srcObject = stream;

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      resolve(video);
    };
  });
}

async function loadVideo() {
  const video = await setupCamera();
  video.play();

  return video;
}

const guiState = {
  algorithm: 'multi-pose',
  input: {
    mobileNetArchitecture: isMobile() ? '0.50' : '0.75',
    outputStride: 16,
    imageScaleFactor: 0.5,
  },
  singlePoseDetection: {
    minPoseConfidence: 0.1,
    minPartConfidence: 0.5,
  },
  multiPoseDetection: {
    maxPoseDetections: 1,
    minPoseConfidence: 0.15,
    minPartConfidence: 0.1,
    nmsRadius: 30.0,
  },
  output: {
    showVideo: true,
    showSkeleton: true,
    showPoints: true,
    showBoundingBox: false,
  },
  net: null,
};

/**
 * Sets up dat.gui controller on the top-right of the window
 */
function setupGui(cameras, net) {
  guiState.net = net;

  if (cameras.length > 0) {
    guiState.camera = cameras[0].deviceId;
  }

  const gui = new dat.GUI({width: 300, autoPlace: false});

    const customContainer = document.getElementById('gui-container');
    customContainer.appendChild(gui.domElement);

  // The single-pose algorithm is faster and simpler but requires only one
  // person to be in the frame or results will be innaccurate. Multi-pose works
  // for more than 1 person
  const algorithmController =
      gui.add(guiState, 'algorithm', ['single-pose', 'multi-pose']);

  // The input parameters have the most effect on accuracy and speed of the
  // network
  let input = gui.addFolder('Input');
  // Architecture: there are a few PoseNet models varying in size and
  // accuracy. 1.01 is the largest, but will be the slowest. 0.50 is the
  // fastest, but least accurate.
  const architectureController = input.add(
      guiState.input, 'mobileNetArchitecture',
      ['1.01', '1.00', '0.75', '0.50']);
  // Output stride:  Internally, this parameter affects the height and width of
  // the layers in the neural network. The lower the value of the output stride
  // the higher the accuracy but slower the speed, the higher the value the
  // faster the speed but lower the accuracy.
  input.add(guiState.input, 'outputStride', [8, 16, 32]);
  // Image scale factor: What to scale the image by before feeding it through
  // the network.
  input.add(guiState.input, 'imageScaleFactor').min(0.2).max(1.0);
  input.open();

  // Pose confidence: the overall confidence in the estimation of a person's
  // pose (i.e. a person detected in a frame)
  // Min part confidence: the confidence that a particular estimated keypoint
  // position is accurate (i.e. the elbow's position)
  let single = gui.addFolder('Single Pose Detection');
  single.add(guiState.singlePoseDetection, 'minPoseConfidence', 0.0, 1.0);
  single.add(guiState.singlePoseDetection, 'minPartConfidence', 0.0, 1.0);

  let multi = gui.addFolder('Multi Pose Detection');
  multi.add(guiState.multiPoseDetection, 'maxPoseDetections')
      .min(1)
      .max(20)
      .step(1);
  multi.add(guiState.multiPoseDetection, 'minPoseConfidence', 0.0, 1.0);
  multi.add(guiState.multiPoseDetection, 'minPartConfidence', 0.0, 1.0);
  // nms Radius: controls the minimum distance between poses that are returned
  // defaults to 20, which is probably fine for most use cases
  multi.add(guiState.multiPoseDetection, 'nmsRadius').min(0.0).max(40.0);
  multi.open();

  let output = gui.addFolder('Output');
  output.add(guiState.output, 'showVideo');
  output.add(guiState.output, 'showSkeleton');
  output.add(guiState.output, 'showPoints');
  output.add(guiState.output, 'showBoundingBox');
  output.open();


  architectureController.onChange(function(architecture) {
    guiState.changeToArchitecture = architecture;
  });

  algorithmController.onChange(function(value) {
    switch (guiState.algorithm) {
      case 'single-pose':
        multi.close();
        single.open();
        break;
      case 'multi-pose':
        single.close();
        multi.open();
        break;
    }
  });
}

/**
 * Sets up a frames per second panel on the top-left of the window
 */
function setupFPS() {
  stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
  document.body.appendChild(stats.dom);
}

/**
 * Feeds an image to posenet to estimate poses - this is where the magic
 * happens. This function loops with a requestAnimationFrame method.
 */
function detectPoseInRealTime(video, net) {
  const canvas = document.getElementById('output');
  const ctx = canvas.getContext('2d');
  // since images are being fed from a webcam
  const flipHorizontal = true;

  canvas.width = videoWidth;
  canvas.height = videoHeight;

  async function poseDetectionFrame() {
    if (guiState.changeToArchitecture) {
      // Important to purge variables and free up GPU memory
      guiState.net.dispose();

      // Load the PoseNet model weights for either the 0.50, 0.75, 1.00, or 1.01
      // version
      guiState.net = await posenet.load(+guiState.changeToArchitecture);

      guiState.changeToArchitecture = null;
    }

    // Begin monitoring code for frames per second
    stats.begin();

    // Scale an image down to a certain factor. Too large of an image will slow
    // down the GPU
    const imageScaleFactor = guiState.input.imageScaleFactor;
    const outputStride = +guiState.input.outputStride;

    let minPoseConfidence;
    let minPartConfidence;
    switch (guiState.algorithm) {
      case 'single-pose':
        const pose = await guiState.net.estimateSinglePose(
            video, imageScaleFactor, flipHorizontal, outputStride);
        poses.push(pose);

        minPoseConfidence = +guiState.singlePoseDetection.minPoseConfidence;
        minPartConfidence = +guiState.singlePoseDetection.minPartConfidence;
        break;
      case 'multi-pose':
        poses = await guiState.net.estimateMultiplePoses(
            video, imageScaleFactor, flipHorizontal, outputStride,
            guiState.multiPoseDetection.maxPoseDetections,
            guiState.multiPoseDetection.minPartConfidence,
            guiState.multiPoseDetection.nmsRadius);

        minPoseConfidence = +guiState.multiPoseDetection.minPoseConfidence;
        minPartConfidence = +guiState.multiPoseDetection.minPartConfidence;
        break;
    }

    ctx.clearRect(0, 0, videoWidth, videoHeight);

    if (guiState.output.showVideo) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-videoWidth, 0);
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
      ctx.restore();
    }

    // For each pose (i.e. person) detected in an image, loop through the poses
    // and draw the resulting skeleton and keypoints if over certain confidence
    // scores
    poses.forEach(({score, keypoints}) => {
      if (score >= minPoseConfidence) {
        if (guiState.output.showPoints) {
          drawKeypoints(keypoints, minPartConfidence, ctx);
        }
        if (guiState.output.showSkeleton) {
          drawSkeleton(keypoints, minPartConfidence, ctx);
        }
        if (guiState.output.showBoundingBox) {
          drawBoundingBox(keypoints, ctx);
        }

        // eslint-disable-next-line max-len
        calibrationStandingPose(calibrationExecutedForStandingPose, keypoints).catch((error) => null);

        countCycles(keypoints);
      }
    });

      if (calibrationContinue) {
          console.log('calibaration continue');

          document.getElementById('counter').style.backgroundColor = 'green';
          let lastPose = poses.slice(-1).pop();
          saveCalibratedPoints('squatPose', lastPose.keypoints);
          calibrationContinue = false;
          emptyInstructionImage();
          // eslint-disable-next-line max-len
          document.getElementById('countdowntimer').textContent = 'start exercise!';
      }

      // drawCalibrationPoints(ctx);

    // End monitoring code for frames per second
    stats.end();

    requestAnimationFrame(poseDetectionFrame);
  }

  poseDetectionFrame();
}

function calibrationStandingPose(executed) {
    if (!executed) {
        calibrationExecutedForStandingPose = true;

        return new Promise((resolve) => {
            let timeleft = 5;
            let downloadTimer = setInterval(() => {
                timeleft--;
                // eslint-disable-next-line max-len
                document.getElementById('countdowntimer').textContent = 'Please hold still. The pose calibration will end in ' + timeleft + ' seconds.';
                if (timeleft <= 0) {
                    clearInterval(downloadTimer);
                    resolve();
                }
            }, 1000);
        }).then(() => {
            const keypoints = poses[0].keypoints;
            saveCalibratedPoints('standing', keypoints);
            addImageOfPose('./images/squat.jpg');
        }).then(() => {
            document.getElementById('counter').style.backgroundColor = 'yellow';
            new Promise((resolve) => {
                let timeleft = 5;
                let downloadTimer = setInterval(() => {
                    timeleft--;
                    // eslint-disable-next-line max-len
                    document.getElementById('countdowntimer').textContent = 'Please hold still. The second pose calibration will end in ' + timeleft + ' seconds. ';
                    if (timeleft <= 0) {
                        clearInterval(downloadTimer);
                        resolve();
                    }
                }, 1000);
            }).then(() => {
                calibrationContinue = true;
            });
        });
    } else {
      return new Promise((resolve, reject) => {
          reject('calibration standing pose rejected');
      });
    }
}

function addImageOfPose(src) {
  let imageElem = document.createElement('img');
  imageElem.setAttribute('src', src);
  imageElem.setAttribute('height', 240);
  imageElem.setAttribute('width', 512);

  emptyInstructionImage().appendChild(imageElem);
}

function emptyInstructionImage() {
    let divElem = document.getElementById('calibration-pose');
    while (divElem.firstChild) {
        divElem.removeChild(divElem.firstChild);
    }

    return divElem;
}

function saveCalibratedPoints(poseType, keypoints) {
    calibrationPoints.set(poseType, keypoints);
}

function countCycles(keypoints) {
    if (calibrationPoints.size >= 2) {
        // eslint-disable-next-line one-var
        let squatPoseKeypoints = calibrationPoints.get('squatPose'),
            // eslint-disable-next-line max-len
            isSquatPose = isAnyKeypointCloseToCalibrated(keypoints, squatPoseKeypoints),
            standingPoseKeypoints = calibrationPoints.get('standing'),
            // eslint-disable-next-line max-len
            isStanding = isAnyKeypointCloseToCalibrated(keypoints, standingPoseKeypoints);

        moveSlider(keypoints, squatPoseKeypoints, standingPoseKeypoints);
        if (isStanding) {
            cycles.set('standingPose');
            // let handler = document.getElementsByClassName('slider-handle');
            sliderTo(100);
        } else if (isSquatPose ) {
            cycles.set('squatPose');
            sliderTo(0);
        }

        fullCycleCounter(isStanding);
    }
}

function fullCycleCounter(isStanding) {
  if (cycles.size === 2 && isStanding) {
    fullCyclesCounted++;
    cycles.clear();
    document.getElementById('counter').textContent = fullCyclesCounted;
  }
}

// eslint-disable-next-line no-unused-vars
function drawCalibrationPoints(ctx) {
    // eslint-disable-next-line max-len
    if (calibrationPoints.has('squatPose') && calibrationPoints.has('standing')) {
        // eslint-disable-next-line one-var
        let squatePoints = calibrationPoints.get('squatPose'),
            noseForSquate = squatePoints[0],
            yNoseForSquate = noseForSquate.position.y,
            xNoseForSquate = noseForSquate.position.x,
            standingPoints = calibrationPoints.get('standing'),
            noseForStanding = standingPoints[0],
            yNoseForStanding = noseForStanding.position.y,
            xNoseForStanding = noseForStanding.position.x;

        drawPoint(ctx, yNoseForStanding, xNoseForStanding, 5, 'red');
        drawPoint(ctx, yNoseForSquate, xNoseForSquate, 5, 'yellow');
    }
}

function isAnyKeypointCloseToCalibrated(keypoints, calibratedKeypoints) {
    // eslint-disable-next-line one-var
        let keypoint = keypoints[0],
            calibrateKeypoint = calibratedKeypoints[0];

        if ( keypoint.score > minimumPartConfidence) {
            return isKeypointCloseToCalubratedByYCoordinates(
                keypoint.position.y,
                calibrateKeypoint.position.y
            );
        }

    return false;
}

function isKeypointCloseToCalubratedByYCoordinates(y1, yCalibrated) {
    // eslint-disable-next-line one-var
    let pixelsLower = yCalibrated * 1.05,
    pixelsHigher = yCalibrated * 0.95;

    return y1 > pixelsHigher && y1 < pixelsLower;
}

function moveSlider(keypoints, yCalibrated, yMaxCalibrated) {
    // eslint-disable-next-line one-var
  let currentPoint = keypoints[0].position.y,
      calibrateKeypointForSquate = yCalibrated[0].position.y;

  sliderTo(Math.abs(currentPoint - calibrateKeypointForSquate));
}

/**
 * Kicks off the demo by loading the posenet model, finding and loading
 * available camera devices, and setting off the detectPoseInRealTime function.
 */
export async function bindPage() {
  // Load the PoseNet model weights with architecture 0.75
  const net = await posenet.load(0.75);

  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';

  let video;

  try {
    video = await loadVideo();
  } catch (e) {
    let info = document.getElementById('info');
    info.textContent = 'this browser does not support video capture,' +
        'or this device does not have a camera';
    info.style.display = 'block';
    throw e;
  }

  setupGui([], net);
  setupFPS();
  detectPoseInRealTime(video, net);
}

navigator.getUserMedia = navigator.getUserMedia ||
    navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
// kick off the demo
bindPage();
