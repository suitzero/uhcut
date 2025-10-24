const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let isDrawing = false;
let lastX = 0;
let lastY = 0;

function draw(e) {
    if (!isDrawing) return;

    // Get the position of the pointer relative to the canvas
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    [lastX, lastY] = [x, y];
}

canvas.addEventListener('pointerdown', (e) => {
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    [lastX, lastY] = [e.clientX - rect.left, e.clientY - rect.top];
});

canvas.addEventListener('pointermove', draw);
canvas.addEventListener('pointerup', () => isDrawing = false);
canvas.addEventListener('pointerout', () => isDrawing = false); // Stop drawing if pointer leaves canvas

// Set initial drawing styles
ctx.strokeStyle = 'black';
ctx.lineWidth = 5;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

const colorPalette = document.querySelector('.color-palette');

colorPalette.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-box')) {
        ctx.strokeStyle = e.target.dataset.color;
    }
});

const clearButton = document.getElementById('clear-button');
const recordButton = document.getElementById('record-button');
const exportButton = document.getElementById('export-button');
const previewButton = document.getElementById('preview-button');
const previewVideo = document.getElementById('preview');

let mediaRecorder;
let recordedChunks = [];

clearButton.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
});

recordButton.addEventListener('click', async () => {
    if (recordButton.textContent === 'Record') {
        recordedChunks = []; // Clear previous recordings
        const stream = canvas.captureStream();
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const compositeStream = new MediaStream([...stream.getTracks(), ...audioStream.getTracks()]);

        mediaRecorder = new MediaRecorder(compositeStream);
        mediaRecorder.start();
        recordButton.textContent = 'Stop';

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                recordedChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            exportButton.textContent = "Export Ready";
        };

        mediaRecorder.onerror = (event) => {
            const h1 = document.querySelector('h1');
            h1.textContent = 'Error: ' + event.error.name;
        };

    } else {
        mediaRecorder.stop();
        recordButton.textContent = 'Record';
    }
});

exportButton.addEventListener('click', () => {
    if (recordedChunks.length === 0) {
        alert("No recording to export!");
        return;
    }
    const blob = new Blob(recordedChunks, {
        type: 'video/webm'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.style = 'display: none';
    a.href = url;
    a.download = 'recording.webm';
    a.click();
    window.URL.revokeObjectURL(url);
});

previewButton.addEventListener('click', () => {
    if (recordedChunks.length === 0) {
        alert("No recording to preview!");
        return;
    }
    const blob = new Blob(recordedChunks, {
        type: 'video/webm'
    });
    const url = URL.createObjectURL(blob);
    previewVideo.src = url;
    previewVideo.style.display = 'block';
});
