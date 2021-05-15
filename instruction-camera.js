const width = document.getElementById('instructions').offsetWidth;

const constraints = {
    'audio': false,
    'video': {
        facingMode: 'user',
        width: width*0.6,
        height: width*0.5,

    }
};

const video = document.querySelector('video');

navigator.mediaDevices.getUserMedia(constraints).
then((stream) => {video.srcObject = stream});