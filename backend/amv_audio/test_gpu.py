import unittest
from unittest.mock import patch
import subprocess

from amv_audio.gpu import check_nvidia_gpu

class TestCheckNvidiaGpu(unittest.TestCase):
    @patch('amv_audio.gpu.subprocess.run')
    def test_check_nvidia_gpu_success(self, mock_run):
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = "NVIDIA GeForce RTX 3080\n"

        result = check_nvidia_gpu()

        self.assertEqual(result, "NVIDIA GeForce RTX 3080")
        mock_run.assert_called_once_with(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )

    @patch('amv_audio.gpu.subprocess.run')
    def test_check_nvidia_gpu_file_not_found(self, mock_run):
        mock_run.side_effect = FileNotFoundError()

        result = check_nvidia_gpu()

        self.assertIsNone(result)

    @patch('amv_audio.gpu.subprocess.run')
    def test_check_nvidia_gpu_timeout_expired(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["nvidia-smi"], timeout=10)

        result = check_nvidia_gpu()

        self.assertIsNone(result)

    @patch('amv_audio.gpu.subprocess.run')
    def test_check_nvidia_gpu_os_error(self, mock_run):
        mock_run.side_effect = OSError()

        result = check_nvidia_gpu()

        self.assertIsNone(result)

    @patch('amv_audio.gpu.subprocess.run')
    def test_check_nvidia_gpu_nonzero_returncode(self, mock_run):
        mock_run.return_value.returncode = 1
        mock_run.return_value.stdout = ""

        result = check_nvidia_gpu()

        self.assertIsNone(result)

    @patch('amv_audio.gpu.subprocess.run')
    def test_check_nvidia_gpu_empty_stdout(self, mock_run):
        mock_run.return_value.returncode = 0
        mock_run.return_value.stdout = "   \n"

        result = check_nvidia_gpu()

        self.assertIsNone(result)

if __name__ == '__main__':
    unittest.main()
