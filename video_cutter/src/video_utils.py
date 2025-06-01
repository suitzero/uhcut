from moviepy.editor import VideoFileClip

def cut_video(input_path: str, start_time: float, end_time: float, output_path: str):
    """
    Cuts a segment from a video file and saves it to a new file.

    Args:
        input_path: Path to the input video file.
        start_time: Start time of the cut in seconds.
        end_time: End time of the cut in seconds.
        output_path: Path to save the cut video segment.
    """
    try:
        # Load the video clip
        clip = VideoFileClip(input_path)

        # Cut the clip
        cut_clip = clip.subclip(start_time, end_time)

        # Write the result to a file
        cut_clip.write_videofile(output_path, codec="libx264", audio_codec="aac")

        # Close the clips
        clip.close()
        cut_clip.close()
        print(f"Successfully cut video '{input_path}' from {start_time}s to {end_time}s and saved to '{output_path}'")

    except Exception as e:
        print(f"An error occurred during video processing in cut_video: {e}")
        # It might be useful to log more details or raise a custom exception here
        # depending on how this function is used as part of a larger application.
        raise # Re-raise the exception to allow calling code to handle it if needed.

if __name__ == '__main__':
    # This is an example of how to use the function.
    # You'll need a sample video file (e.g., 'sample.mp4') in the root directory
    # or provide the correct path to an existing video file.
    # Ensure moviepy and its dependencies (like ffmpeg) are installed.

    # Create a dummy sample.mp4 for testing if it doesn't exist.
    # This part is tricky to do robustly without knowing the environment's capabilities
    # for creating actual video files. For now, we'll assume a sample video exists
    # or the user will provide one.

    # Example usage (requires a 'sample.mp4' file or similar):
    # cut_video('sample.mp4', 5, 10, 'output_cut.mp4')
    pass
