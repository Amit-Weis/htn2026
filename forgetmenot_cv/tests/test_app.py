from src.app import main


def test_unsupported_target_is_reported_before_model_load(capsys, tmp_path):
    exit_code = main([
        "--image", str(tmp_path / "missing.jpg"),
        "--target", "wallet",
        "--model", str(tmp_path / "missing.tflite"),
    ])
    assert exit_code == 2
    assert "Unsupported target" in capsys.readouterr().err
