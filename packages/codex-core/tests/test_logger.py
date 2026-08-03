import json
import logging

from codex_core.logger import JsonFormatter, setup_json_logging


def test_json_formatter_emits_serializable_line():
    record = logging.LogRecord(
        name="codex-core.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=10,
        msg="hello %s",
        args=("world",),
        exc_info=None,
    )
    line = JsonFormatter().format(record)
    payload = json.loads(line)
    assert payload["level"] == "INFO"
    assert payload["message"] == "hello world"
    assert payload["logger"] == "codex-core.test"


def test_setup_json_logging_installs_handler():
    setup_json_logging()
    assert any(getattr(handler, "_codex_json", False) for handler in logging.getLogger().handlers)
