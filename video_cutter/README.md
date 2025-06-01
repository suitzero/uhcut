# Simple Video Cutter CLI

This is a command-line tool to cut segments from video files using Python and MoviePy.

## Features

- Cut a video based on specified start and end times (in seconds).
- Outputs the cut segment to a new video file.

## Prerequisites

- Python 3.x
- FFmpeg: MoviePy relies on FFmpeg for video processing. You need to have FFmpeg installed on your system and accessible in your PATH.
    - On Debian/Ubuntu: `sudo apt update && sudo apt install ffmpeg`
    - On macOS (using Homebrew): `brew install ffmpeg`
    - On Windows: Download from the official FFmpeg website and add the `bin` directory to your system's PATH.

## Installation

1.  **Clone the repository (or download the files):**
    ```bash
    # If this were a git repo:
    # git clone <repository_url>
    # cd video_cutter
    # For now, just ensure you have the 'video_cutter' directory with its contents.
    ```

2.  **Create a virtual environment (recommended):**
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows: venv\Scripts\activate
    ```

3.  **Install dependencies:**
    Navigate to the `video_cutter` root directory (where `requirements.txt` is located) and run:
    ```bash
    pip install -r requirements.txt
    ```
    This will install `moviepy==1.0.3` and its dependencies.

## Usage

Navigate to the `video_cutter/src` directory to run the `main.py` script.

```bash
cd src # or python src/main.py from the video_cutter directory.
python main.py <input_video_path> <start_time_seconds> <end_time_seconds> <output_video_path>
```

**Example:**

To cut a video named `my_input_video.mp4` from 5.5 seconds to 12.0 seconds and save it as `cut_output.mp4`:

```bash
# Assuming my_input_video.mp4 is in the current directory or you provide the full path
# and you are in the video_cutter/src directory:
python main.py ../my_input_video.mp4 5.5 12.0 ../cut_output.mp4

# If you are in the video_cutter root directory:
python src/main.py my_input_video.mp4 5.5 12.0 cut_output.mp4
```

### Arguments

-   `input_video_path`: Path to the input video file.
-   `start_time_seconds`: Start time of the cut in seconds (e.g., `5.0`).
-   `end_time_seconds`: End time of the cut in seconds (e.g., `10.5`).
-   `output_video_path`: Path where the cut video segment will be saved.

## How it Works

The tool uses the `moviepy` library to load the input video, extract the subclip defined by the start and end times, and then write this subclip to the specified output file.

## Running Tests

Tests are located in the `tests` directory and use Python's `unittest` module. To run the tests, navigate to the `video_cutter` root directory and run:

```bash
python -m unittest discover tests
```
or
```bash
python -m unittest tests.test_video_utils
```

This will discover and run the tests defined in `test_video_utils.py`. The current tests mock the `moviepy` library calls to avoid requiring actual video files during testing.
