from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from ctypes import wintypes

from pywinauto import Desktop, keyboard

try:
    import win32clipboard
except Exception:
    win32clipboard = None


CHATGPT_HOST = "chatgpt.com"
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
INPUT_NAMES = {
    "询问 ChatGPT",
    "发送消息",
    "Ask ChatGPT",
    "Message ChatGPT",
}
SEND_NAMES = {"发送", "Send"}
STOP_NAMES = {"停止", "停止生成", "Stop generating", "Stop"}
DOWNLOAD_NAMES = {
    "下载",
    "下载图片",
    "Download",
    "Download image",
}
COPY_IMAGE_NAMES = {"复制图像", "Copy image"}

STATE_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Xiaoshuren-Media-MCP"
STATE_FILE = STATE_DIR / "chatgpt-web-jobs.json"
CHROME_EXE = os.environ.get(
    "CHATGPT_WEB_CHROME_EXE",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
)
CHROME_PROFILE = os.environ.get("CHATGPT_WEB_CHROME_PROFILE", "Default")


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(STATE_FILE)


def update_job(request_id: str, **values) -> dict:
    state = load_state()
    job = dict(state.get(request_id) or {})
    job.update(values)
    job["request_id"] = request_id
    job["updated_at"] = datetime.now(timezone.utc).isoformat()
    state[request_id] = job
    save_state(state)
    return job


def output(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def normalize_url(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return "https://" + value


def is_chatgpt_url(value: str) -> bool:
    try:
        return normalize_url(value).split("://", 1)[1].split("/", 1)[0].lower() == CHATGPT_HOST
    except Exception:
        return False


def chrome_windows():
    user32 = ctypes.windll.user32
    handles = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value
        if "Google Chrome" in title:
            handles.append(hwnd)
        return True

    user32.EnumWindows(enum_proc, 0)
    desktop = Desktop(backend="uia")
    windows = []
    for handle in handles:
        try:
            windows.append(desktop.window(handle=handle))
        except Exception:
            continue
    return windows


def chrome_window_by_handle(handle):
    if not handle:
        return None
    try:
        window = Desktop(backend="uia").window(handle=int(handle))
        if window.exists(timeout=0.5) and window.is_visible():
            return window
    except Exception:
        pass
    return None


def force_foreground(window):
    hwnd = int(window.handle)
    user32 = ctypes.windll.user32
    try:
        user32.ShowWindow(hwnd, 9)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.35)
    except Exception:
        pass


def address_value(window) -> str:
    for element in window.descendants(control_type="Edit"):
        try:
            value = element.window_text().strip()
            rect = element.rectangle()
        except Exception:
            continue
        # Chrome's address bar lives in the browser chrome near the top of the
        # window and is substantially wider than page textboxes or extensions.
        if rect.top <= 120 and rect.bottom <= 130 and (rect.right - rect.left) >= 300:
            return value
    return ""


def chatgpt_address_value(window) -> str:
    value = address_value(window)
    if is_chatgpt_url(value):
        return value
    return ""


def all_edit_values(window):
    values = []
    for element in window.descendants(control_type="Edit"):
        try:
            value = element.window_text().strip()
            if value:
                values.append(value)
        except Exception:
            pass
    return values


def find_message_edit(window):
    candidates = []
    for element in window.descendants(control_type="Edit"):
        try:
            value = element.window_text().strip()
            rect = element.rectangle()
        except Exception:
            continue
        if value in INPUT_NAMES:
            return element
        if not is_chatgpt_url(value) and rect.top >= 0:
            candidates.append((rect.top, element, value))
    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]
    return None


def find_button(window, names):
    for element in window.descendants(control_type="Button"):
        try:
            if element.window_text().strip() in names:
                return element
        except Exception:
            pass
    return None


def scan_chatgpt_tab(max_tabs: int = 80):
    for window in chrome_windows():
        try:
            current = chatgpt_address_value(window)
            if current:
                return window, current
        except Exception:
            pass

        tabs = window.descendants(control_type="TabItem")
        for tab in tabs[:max_tabs]:
            try:
                tab.select()
                time.sleep(0.10)
                current = chatgpt_address_value(window)
                if current:
                    return window, current
            except Exception:
                continue
    raise RuntimeError("No logged-in ChatGPT tab was found in Google Chrome")


def clipboard_paste(text: str) -> None:
    if win32clipboard is None:
        raise RuntimeError("win32clipboard is required for Unicode-safe browser input")

    previous = None
    try:
        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32clipboard.CF_UNICODETEXT):
                previous = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
        except Exception:
            previous = None
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        win32clipboard.CloseClipboard()
        keyboard.send_keys("^v")
        time.sleep(0.55)
    finally:
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            if previous is not None:
                win32clipboard.SetClipboardText(previous, win32clipboard.CF_UNICODETEXT)
            win32clipboard.CloseClipboard()
        except Exception:
            pass


def navigate_current_tab(window, url: str, timeout: float = 30.0):
    window.set_focus()
    keyboard.send_keys("^l")
    time.sleep(0.1)
    clipboard_paste(url)
    keyboard.send_keys("{ENTER}")

    deadline = time.time() + timeout
    while time.time() < deadline:
        value = address_value(window)
        if value and is_chatgpt_url(value):
            return value
        time.sleep(0.25)
    raise RuntimeError("ChatGPT navigation timed out")


def open_provider_tab(window=None, url="https://chatgpt.com/"):
    before = {candidate.handle for candidate in chrome_windows()}
    subprocess.Popen(
        [
            CHROME_EXE,
            f"--profile-directory={CHROME_PROFILE}",
            "--new-window",
            url,
        ],
        close_fds=True,
    )

    deadline = time.time() + 15.0
    provider_window = None
    while time.time() < deadline:
        for candidate in chrome_windows():
            if candidate.handle not in before:
                current = normalize_url(address_value(candidate))
                if is_chatgpt_url(current):
                    provider_window = candidate
                    break
        if provider_window is not None:
            break
        time.sleep(0.15)

    if provider_window is None:
        raise RuntimeError("A dedicated Chrome provider window could not be created")
    return provider_window


def wait_for_message_edit(window, timeout: float = 30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        editor = find_message_edit(window)
        if editor is not None:
            return editor
        time.sleep(0.25)
    raise RuntimeError("ChatGPT message input did not become available")


def wait_for_conversation_url(window, timeout: float = 30.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = address_value(window)
        normalized = normalize_url(value)
        if re.search(r"https://chatgpt\.com/(c|dots)/[^/?#]+", normalized):
            return normalized
        time.sleep(0.25)
    raise RuntimeError("ChatGPT conversation URL was not observed")


def open_conversation(provider_job_id: str):
    target = normalize_url(provider_job_id)
    target_path = target.split("chatgpt.com", 1)[-1]

    for window in chrome_windows():
        tabs = window.descendants(control_type="TabItem")
        for tab in tabs[:80]:
            try:
                tab.click_input()
                time.sleep(0.08)
                current = normalize_url(address_value(window))
                if current and current.split("chatgpt.com", 1)[-1] == target_path:
                    return window
            except Exception:
                continue

    windows = chrome_windows()
    if not windows:
        raise RuntimeError("No Google Chrome window is available")
    window = windows[0]
    window.set_focus()
    keyboard.send_keys("^t")
    time.sleep(0.2)
    navigate_current_tab(window, target)
    return window


def ui_snapshot(window):
    buttons = []
    images = []
    texts = []
    for element in window.descendants():
        try:
            name = element.window_text().strip()
            if not name:
                continue
            control = element.element_info.control_type
            if control == "Button":
                buttons.append(name)
            elif control == "Image":
                images.append(name)
            elif control == "Text":
                texts.append(name)
        except Exception:
            continue
    return buttons, images, texts


def generated_image_candidates(buttons, images):
    names = []
    for name in buttons + images:
        lower = name.lower()
        if (
            any(lower.endswith(ext) for ext in IMAGE_EXTENSIONS)
            or "generated image" in lower
            or "生成的图" in name
        ):
            if name.startswith("展开 "):
                name = name[3:].strip()
            elif name.lower().startswith("open "):
                name = name[5:].strip()
            names.append(name)
    return list(dict.fromkeys(names))


def download_latest_image(window, download_dir: Path, timeout: float = 30.0):
    download_dir.mkdir(parents=True, exist_ok=True)

    copy_button = find_button(window, COPY_IMAGE_NAMES)
    if copy_button is not None:
        try:
            if win32clipboard is not None:
                win32clipboard.OpenClipboard()
                win32clipboard.EmptyClipboard()
                win32clipboard.CloseClipboard()
        except Exception:
            pass
        force_foreground(window)
        copy_button.click_input()
        time.sleep(1.0)
        target = download_dir / f"chatgpt-{int(time.time())}.png"
        helper = Path(__file__).with_name("save_clipboard_image.ps1")
        for _attempt in range(4):
            try:
                saved = subprocess.run(
                    [
                        "powershell",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(helper),
                        "-Path",
                        str(target),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                if saved.returncode == 0 and target.exists() and target.stat().st_size > 0:
                    return str(target.resolve())
            except Exception:
                pass
            time.sleep(0.65)

    browser_download_dir = Path.home() / "Downloads"
    browser_download_dir.mkdir(parents=True, exist_ok=True)
    watched_dirs = [browser_download_dir]
    if download_dir.resolve() != browser_download_dir.resolve():
        watched_dirs.append(download_dir)

    before = set()
    for watched in watched_dirs:
        before.update(
            path.resolve()
            for path in watched.iterdir()
            if path.is_file()
        )

    expand_buttons = []
    for element in window.descendants(control_type="Button"):
        try:
            name = element.window_text().strip()
        except Exception:
            continue
        lower = name.lower()
        if (
            (name.startswith("展开 ") or lower.startswith("open "))
            and any(lower.endswith(ext) for ext in IMAGE_EXTENSIONS)
        ):
            expand_buttons.append(element)

    if expand_buttons:
        expand_buttons[-1].click_input()
    else:
        image_controls = []
        for element in window.descendants(control_type="Image"):
            try:
                name = element.window_text().strip()
            except Exception:
                continue
            lower = name.lower()
            if (
                any(lower.endswith(ext) for ext in IMAGE_EXTENSIONS)
                or "generated image" in lower
                or "生成的图" in name
            ):
                image_controls.append(element)
        if not image_controls:
            return None
        image_controls[-1].click_input()
    time.sleep(0.8)

    download = find_button(window, DOWNLOAD_NAMES)
    if download is None:
        for element in window.descendants(control_type="Button"):
            try:
                name = element.window_text().strip()
                if "下载" in name or "download" in name.lower():
                    download = element
                    break
            except Exception:
                pass

    if download is None:
        keyboard.send_keys("{ESC}")
        return None

    download.click_input()

    deadline = time.time() + timeout
    while time.time() < deadline:
        current = set()
        for watched in watched_dirs:
            current.update(
                path.resolve()
                for path in watched.iterdir()
                if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
            )
        created = sorted(
            current - before,
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if created:
            source = created[0]
            if source.parent.resolve() != download_dir.resolve():
                target = download_dir / source.name
                if target.exists():
                    target = download_dir / f"{source.stem}-{int(time.time())}{source.suffix}"
                shutil.move(str(source), str(target))
                source = target.resolve()
            keyboard.send_keys("{ESC}")
            return str(source)
        time.sleep(0.25)

    keyboard.send_keys("{ESC}")
    return None


def command_probe(_payload):
    window, url = scan_chatgpt_tab()
    editor = find_message_edit(window)
    send = find_button(window, SEND_NAMES)
    return {
        "ok": True,
        "browser": "Google Chrome",
        "conversation_url": normalize_url(url),
        "has_message_input": editor is not None,
        "has_send_button": send is not None,
    }


def command_submit(payload):
    prompt = str(payload.get("prompt") or "").strip()
    request_id = str(payload.get("request_id") or "").strip()
    if not prompt:
        raise RuntimeError("prompt is required")
    if not request_id:
        raise RuntimeError("request_id is required")

    existing = load_state().get(request_id)
    if existing:
        return {
            "ok": True,
            "provider_job_id": request_id,
            "conversation_url": existing.get("conversation_url"),
            "status": existing.get("status") or "unknown",
            "replayed": True,
        }

    update_job(request_id, status="starting")
    try:
        window, _ = scan_chatgpt_tab()
        window = open_provider_tab(window)
        update_job(request_id, status="starting", window_handle=window.handle)
        force_foreground(window)
        editor = wait_for_message_edit(window)
        observed_prompt = ""
        for _attempt in range(3):
            force_foreground(window)
            try:
                editor.set_focus()
            except Exception:
                pass
            editor.click_input()
            time.sleep(0.25)
            keyboard.send_keys("^a")
            time.sleep(0.18)
            keyboard.send_keys("{BACKSPACE}")
            time.sleep(0.35)
            clipboard_paste(prompt)
            time.sleep(0.85)
            fresh_editor = find_message_edit(window)
            if fresh_editor is not None:
                editor = fresh_editor
            observed_prompt = editor.window_text().strip()
            if prompt[:80] in observed_prompt:
                break
        if prompt[:80] not in observed_prompt:
            raise RuntimeError("ChatGPT prompt input verification failed")

        force_foreground(window)
        send = find_button(window, SEND_NAMES)
        if send is None:
            raise RuntimeError("ChatGPT send button was not found")
        send.click_input()

        conversation_url = wait_for_conversation_url(window)
        update_job(
            request_id,
            status="submitted",
            conversation_url=conversation_url,
            window_handle=window.handle,
        )
    except Exception as error:
        update_job(request_id, status="unknown", last_error=str(error))
        raise

    return {
        "ok": True,
        "provider_job_id": request_id,
        "conversation_url": conversation_url,
        "status": "submitted",
    }


def command_status(payload):
    provider_job_id = str(payload.get("provider_job_id") or "").strip()
    if not provider_job_id:
        raise RuntimeError("provider_job_id is required")

    job = load_state().get(provider_job_id)
    if not job:
        return {"ok": True, "status": "unknown"}

    window = chrome_window_by_handle(job.get("window_handle"))
    if window is None:
        conversation_url = str(job.get("conversation_url") or "").strip()
        if not conversation_url:
            return {"ok": True, "status": "unknown"}
        seed_window, _ = scan_chatgpt_tab()
        window = open_provider_tab(seed_window, conversation_url)
        update_job(provider_job_id, window_handle=window.handle)

    current_url = normalize_url(address_value(window))
    if (
        re.search(r"https://chatgpt\.com/(c|dots)/[^/?#]+", current_url)
        and current_url != job.get("conversation_url")
    ):
        update_job(provider_job_id, conversation_url=current_url)
    force_foreground(window)
    keyboard.send_keys("{END}")
    time.sleep(0.5)

    buttons, images, texts = ui_snapshot(window)
    lower_blob = "\n".join(buttons + texts).lower()
    if any(name.lower() in lower_blob for name in STOP_NAMES):
        update_job(provider_job_id, status="running")
        return {"ok": True, "status": "running"}

    error_markers = [
        "something went wrong",
        "出了点问题",
        "发生错误",
        "unable to generate",
        "无法生成",
    ]
    if any(marker in lower_blob for marker in error_markers):
        update_job(provider_job_id, status="failed")
        return {"ok": True, "status": "failed", "error": "ChatGPT image generation failed"}

    candidates = generated_image_candidates(buttons, images)
    if not candidates:
        update_job(provider_job_id, status="running")
        return {"ok": True, "status": "running"}

    download_dir = Path(
        payload.get("download_dir")
        or Path.home() / "Downloads" / "Xiaoshuren-Media-MCP"
    )
    local_path = download_latest_image(window, download_dir)
    if not local_path:
        update_job(
            provider_job_id,
            status="running",
            image_detected=True,
            filename=candidates[-1],
        )
        return {
            "ok": True,
            "status": "running",
            "image_detected": True,
            "filename": candidates[-1],
        }

    update_job(
        provider_job_id,
        status="succeeded",
        local_path=local_path,
        filename=Path(local_path).name,
    )
    return {
        "ok": True,
        "status": "succeeded",
        "filename": Path(local_path).name,
        "local_path": local_path,
        "mime_type": "image/png" if local_path.lower().endswith(".png") else None,
    }


COMMANDS = {
    "probe": command_probe,
    "submit": command_submit,
    "status": command_status,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=sorted(COMMANDS))
    args = parser.parse_args()

    payload = {}
    if not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        if raw:
            payload = json.loads(raw)

    try:
        result = COMMANDS[args.command](payload)
        output(result)
    except Exception as error:
        output({
            "ok": False,
            "error": str(error),
            "error_type": type(error).__name__,
        })
        raise SystemExit(1)


if __name__ == "__main__":
    main()
