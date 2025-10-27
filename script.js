const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const colorPalette = document.querySelector('.color-palette');
const clearButton = document.getElementById('clear-button');
const recordButton = document.getElementById('record-button');
const exportButton = document.getElementById('export-button');
const textToolButton = document.getElementById('text-tool-button');
const previewButton = document.getElementById('preview-button');
const previewVideo = document.getElementById('preview');

let isDrawing = false;
let isTextMode = false;
let lastX = 0;
let lastY = 0;

let mediaRecorder;
let recordedChunks = [];

// Set initial drawing styles
ctx.strokeStyle = 'white';
ctx.fillStyle = 'white';
ctx.lineWidth = 5;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

function draw(e) {
    if (!isDrawing || isTextMode) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    [lastX, lastY] = [x, y];
}

function handleText(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.style.position = 'absolute';
    textInput.style.left = `${e.clientX}px`;
    textInput.style.top = `${e.clientY}px`;
    textInput.style.border = '1px solid #ccc';
    textInput.style.font = '16px sans-serif';
    textInput.style.padding = '5px';
    textInput.style.background = '#1e1e2f';
    textInput.style.color = 'white';

    document.body.appendChild(textInput);
    textInput.focus();

    const finishEditing = () => {
        if (document.body.contains(textInput)) {
            drawText(textInput.value, x, y);
            document.body.removeChild(textInput);
        }
    };

    textInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            finishEditing();
        }
    });

    textInput.addEventListener('blur', finishEditing);
}

function drawText(text, x, y) {
    ctx.font = '16px sans-serif';
    ctx.fillText(text, x, y);
}

canvas.addEventListener('pointerdown', (e) => {
    if (isTextMode) {
        handleText(e);
    } else {
        isDrawing = true;
        const rect = canvas.getBoundingClientRect();
        [lastX, lastY] = [e.clientX - rect.left, e.clientY - rect.top];
    }
});

canvas.addEventListener('pointermove', draw);
canvas.addEventListener('pointerup', () => isDrawing = false);
canvas.addEventListener('pointerout', () => isDrawing = false);

colorPalette.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-box')) {
        const color = e.target.dataset.color;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
    }
});

textToolButton.addEventListener('click', () => {
    isTextMode = !isTextMode;
    textToolButton.classList.toggle('active', isTextMode);
    canvas.style.cursor = isTextMode ? 'text' : 'crosshair';
    // When entering text mode, stop any current drawing
    isDrawing = false;
});

clearButton.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
});

recordButton.addEventListener('click', async () => {
    if (recordButton.textContent === 'Record') {
        recordedChunks = [];
        const stream = canvas.captureStream();
        try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const compositeStream = new MediaStream([...stream.getTracks(), ...audioStream.getTracks()]);
            mediaRecorder = new MediaRecorder(compositeStream);
        } catch (err) {
            console.error("Audio permission denied. Recording video without audio.", err);
            mediaRecorder = new MediaRecorder(stream);
        }

        mediaRecorder.start();
        recordButton.textContent = 'Stop';

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                recordedChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            document.body.dataset.recordingState = 'ready';
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
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.style.display = 'none';
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
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    previewVideo.src = url;
    previewVideo.style.display = 'block';
});
