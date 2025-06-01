import unittest
from unittest.mock import patch, MagicMock
import sys
import os

# Add src directory to Python path to allow direct import of video_utils
# This is a common way to handle imports in test files when the src directory is not a package
# or when running tests directly without installing the package.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../src')))

# Now import the module
try:
    from video_utils import cut_video
except ImportError:
    # This fallback is just in case the sys.path manipulation isn't perfect
    # in all execution environments. Ideally, the project would be structured as a package.
    print("Failed to import video_utils. Ensure video_cutter/src is in PYTHONPATH.")
    # As a simple workaround for some environments, try a relative import if it's structured like a package
    # from ..src.video_utils import cut_video # This line might be problematic depending on test runner

class TestVideoUtils(unittest.TestCase):

    @patch('video_utils.VideoFileClip') # Mock VideoFileClip where it's used in video_utils
    def test_cut_video_success(self, mock_video_file_clip):
        # Setup mock objects
        mock_clip_instance = MagicMock()
        mock_subclip_instance = MagicMock()

        # Configure the mock VideoFileClip to return our clip instance
        mock_video_file_clip.return_value = mock_clip_instance
        # Configure the mock clip's subclip method to return our subclip instance
        mock_clip_instance.subclip.return_value = mock_subclip_instance

        input_path = "dummy_input.mp4"
        start_time = 5.0
        end_time = 10.0
        output_path = "dummy_output.mp4"

        # Call the function to be tested
        # Suppress print output from cut_video during the test
        with patch('builtins.print') as mock_print:
            cut_video(input_path, start_time, end_time, output_path)

        # Assertions
        mock_video_file_clip.assert_called_once_with(input_path)
        mock_clip_instance.subclip.assert_called_once_with(start_time, end_time)
        mock_subclip_instance.write_videofile.assert_called_once_with(output_path, codec="libx264", audio_codec="aac")

        # Check that close methods were called
        mock_clip_instance.close.assert_called_once()
        mock_subclip_instance.close.assert_called_once()

        # Check success message was printed (optional, but good to confirm)
        # mock_print.assert_any_call(f"Successfully cut video '{input_path}' from {start_time}s to {end_time}s and saved to '{output_path}'")


    @patch('video_utils.VideoFileClip')
    @patch('builtins.print') # Mock print to check error messages
    def test_cut_video_exception_handling(self, mock_print, mock_video_file_clip):
        # Configure VideoFileClip to raise an exception
        mock_video_file_clip.side_effect = Exception("Test error opening video")

        input_path = "dummy_input_fail.mp4"
        start_time = 1.0
        end_time = 5.0
        output_path = "dummy_output_fail.mp4"

        # Call the function and assert that it raises an exception
        with self.assertRaises(Exception) as context:
            cut_video(input_path, start_time, end_time, output_path)

        self.assertTrue("Test error opening video" in str(context.exception))
        # Check that the error print message was called
        mock_print.assert_called_with(f"An error occurred during video processing in cut_video: Test error opening video")

if __name__ == '__main__':
    # You might need to navigate to the 'video_cutter' directory and run
    # python -m unittest tests.test_video_utils
    # or python tests/test_video_utils.py from the `video_cutter` root,
    # depending on your environment and how Python resolves modules.
    unittest.main()
