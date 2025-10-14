import os
import imageio
import imageio_ffmpeg
import numpy as np
import ffmpeg
from scenedetect import VideoManager, SceneManager
from scenedetect.detectors import ContentDetector
from uploader import (
    upload_to_youtube,
    upload_to_tiktok,
    upload_to_instagram,
    upload_to_linkedin,
)

def find_scenes(video_path, threshold=30.0):
    """
    Detects scenes in a video file using the ContentDetector algorithm.

    Args:
        video_path (str): The path to the video file.
        threshold (float): The threshold for scene detection.

    Returns:
        A list of tuples, where each tuple contains the start and end
        timecodes of a detected scene.
    """
    video_manager = VideoManager([video_path])
    scene_manager = SceneManager()

    # Add ContentDetector algorithm to the scene_manager.
    scene_manager.add_detector(ContentDetector(threshold=threshold))

    # Perform scene detection.
    video_manager.set_downscale_factor()
    video_manager.start()
    scene_manager.detect_scenes(frame_source=video_manager)

    # Get the list of scenes.
    scene_list = scene_manager.get_scene_list()

    return scene_list

def split_video_into_scenes(video_path, scene_list):
    """
    Splits a video into multiple clips based on a list of scenes.

    Args:
        video_path (str): The path to the video file.
        scene_list (list): A list of tuples, where each tuple contains
                           the start and end timecodes of a scene.
    """
    if not os.path.exists("output"):
        os.makedirs("output")

    for i, scene in enumerate(scene_list):
        start_time = scene[0].get_timecode()
        end_time = scene[1].get_timecode()
        output_filename = f"output/scene_{i+1}.mp4"

        print(f"Cutting scene {i+1}: {start_time} - {end_time}")

        try:
            (
                ffmpeg
                .input(video_path, ss=start_time)
                .output(output_filename, to=end_time, c="copy")
                .run(overwrite_output=True, cmd=imageio_ffmpeg.get_ffmpeg_exe())
            )
        except ffmpeg.Error as e:
            print("ffmpeg error:", e.stderr.decode())

        if not args.skip_upload:
            # Upload to social media
            title = f"Scene {i+1}"
            description = f"A cool scene from the video, starting at {start_time} and ending at {end_time}."
            upload_to_youtube(output_filename, title, description)
            upload_to_tiktok(output_filename, title)
            upload_to_instagram(output_filename, title)
            upload_to_linkedin(output_filename, title, description)

import argparse

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Automatically cut and upload videos to social media.")
    parser.add_argument("video_path", nargs='?', default=None, help="The path to the video file to process.")
    parser.add_argument("--threshold", type=float, default=30.0, help="The threshold for scene detection.")
    parser.add_argument("--skip-upload", action="store_true", help="Skip the social media upload process.")
    parser.add_argument("--use-dummy", action="store_true", help="Use a dummy video for testing.")
    args = parser.parse_args()

    if not args.video_path and not args.use_dummy:
        parser.error("A video path is required unless --use-dummy is specified.")

    video_file = args.video_path

    if args.use_dummy:
        video_file = "input.mp4"
        if not os.path.exists(video_file):
            print(f"Creating a dummy video file: {video_file}")
            # Set the ffmpeg executable path for imageio
            os.environ["IMAGEIO_FFMPEG_EXE"] = imageio_ffmpeg.get_ffmpeg_exe()
            # Create a dummy 10-second video file using imageio.
            writer = imageio.get_writer(video_file, fps=30)
            for i in range(300):
                frame = np.zeros((360, 640, 3), dtype=np.uint8)
                frame[:, :, 0] = i % 256
                frame[:, :, 1] = (i * 2) % 256
                frame[:, :, 2] = (i * 3) % 256
                writer.append_data(frame)
            writer.close()

    scenes = find_scenes(video_file, threshold=args.threshold)

    print(f"Detected {len(scenes)} scenes.")

    # Merge scenes into clips of approximately 60 seconds
    merged_scenes = []
    current_clip = []
    current_duration = 0
    for scene in scenes:
        start_time, end_time = scene
        duration = (end_time - start_time).get_seconds()
        if current_duration + duration > 60:
            merged_scenes.append(current_clip)
            current_clip = [scene]
            current_duration = duration
        else:
            current_clip.append(scene)
            current_duration += duration
    if current_clip:
        merged_scenes.append(current_clip)

    # Create the final clips
    final_scene_list = []
    for clip in merged_scenes:
        start_time = clip[0][0]
        end_time = clip[-1][1]
        final_scene_list.append((start_time, end_time))

    split_video_into_scenes(video_file, final_scene_list)