import argparse
import os
from video_utils import cut_video # Assuming video_utils.py is in the same directory or PYTHONPATH is set

def main():
    parser = argparse.ArgumentParser(description="Cut a video file.")
    parser.add_argument("input_path", help="Path to the input video file.")
    parser.add_argument("start_time", type=float, help="Start time for the cut in seconds (e.g., 5.0).")
    parser.add_argument("end_time", type=float, help="End time for the cut in seconds (e.g., 10.5).")
    parser.add_argument("output_path", help="Path to save the cut video segment.")

    args = parser.parse_args()

    # Basic validation
    if not os.path.exists(args.input_path):
        print(f"Error: Input file '{args.input_path}' not found.")
        return

    if args.start_time >= args.end_time:
        print(f"Error: Start time ({args.start_time}s) must be before end time ({args.end_time}s).")
        return

    if args.start_time < 0:
        print(f"Error: Start time ({args.start_time}s) cannot be negative.")
        return

    # Potentially add a check if output directory exists, or create it.
    # For now, we assume the output directory is valid or moviepy handles it.

    print(f"Input video: {args.input_path}")
    print(f"Start time: {args.start_time}s")
    print(f"End time: {args.end_time}s")
    print(f"Output video: {args.output_path}")

    cut_video(args.input_path, args.start_time, args.end_time, args.output_path)

if __name__ == "__main__":
    main()
