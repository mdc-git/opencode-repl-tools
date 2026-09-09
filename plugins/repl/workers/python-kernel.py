from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import OrderedDict
from contextlib import suppress
from queue import Empty
from typing import Any

from jupyter_client.manager import AsyncKernelManager


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def diagnostic(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    manager = AsyncKernelManager(kernel_name="python3")
    command_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    active_job_id: str | None = None
    active_msg_id: str | None = None
    active_task: asyncio.Task[None] | None = None
    stdin_waiter: asyncio.Future[str] | None = None
    stdin_job_id: str | None = None
    shutting_down = False
    shutdown_done = False

    executions: dict[str, dict[str, Any]] = {}
    parent_jobs: dict[str, str] = {}
    completed_parents: OrderedDict[str, None] = OrderedDict()

    def remember_active(msg_id: str, job_id: str) -> None:
        parent_jobs[msg_id] = job_id
        completed_parents.pop(msg_id, None)

    def remember_completed(msg_id: str) -> None:
        completed_parents[msg_id] = None
        completed_parents.move_to_end(msg_id)
        while len(completed_parents) > 20:
            oldest, _ = completed_parents.popitem(last=False)
            if oldest != active_msg_id:
                parent_jobs.pop(oldest, None)

    def job_for_message(msg: dict[str, Any]) -> str | None:
        parent_id = msg.get("parent_header", {}).get("msg_id")
        return parent_jobs.get(parent_id) if isinstance(parent_id, str) else None

    def emit_output(job_id: str | None, stream: str, text: str) -> None:
        message: dict[str, Any] = {"type": "output", "stream": stream, "text": text}
        if job_id is not None:
            message["jobId"] = job_id
        emit(message)

    await manager.start_kernel(cwd=args.cwd)
    client = manager.client()
    client.start_channels()
    await client.wait_for_ready()
    emit({"type": "ready", "pythonVersion": sys.version.split()[0]})

    async def shutdown_kernel() -> bool:
        nonlocal shutting_down, shutdown_done
        if shutdown_done:
            try:
                return not await manager.is_alive()
            except Exception:
                return False
        shutting_down = True
        confirmed = False
        try:
            try:
                await asyncio.wait_for(manager.shutdown_kernel(now=False), timeout=2.0)
            except Exception:
                with suppress(Exception):
                    await asyncio.wait_for(manager.shutdown_kernel(now=True), timeout=2.0)
            try:
                confirmed = not await manager.is_alive()
            except Exception:
                confirmed = False
        finally:
            with suppress(Exception):
                client.stop_channels()
            shutdown_done = True
        return confirmed

    async def read_commands() -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        while True:
            raw = await reader.readline()
            if raw == b"":
                await command_queue.put({"type": "shutdown"})
                return
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                emit({"type": "fatal", "message": f"invalid control JSON: {exc}"})
                await command_queue.put({"type": "shutdown"})
                return
            if not isinstance(message, dict):
                emit({"type": "fatal", "message": "control message must be an object"})
                continue
            await command_queue.put(message)

    async def iopub_pump() -> None:
        while not shutting_down:
            try:
                msg = await client.get_iopub_msg(timeout=1.0)
            except Empty:
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not shutting_down:
                    emit({"type": "fatal", "message": f"IOPub channel failed: {exc}"})
                    await command_queue.put({"type": "shutdown"})
                return

            msg_type = msg.get("msg_type") or msg.get("header", {}).get("msg_type")
            content = msg.get("content", {})
            parent_id = msg.get("parent_header", {}).get("msg_id")
            job_id = job_for_message(msg)

            if msg_type == "stream":
                stream = content.get("name", "stdout")
                if stream not in ("stdout", "stderr"):
                    stream = "stdout"
                emit_output(job_id, stream, str(content.get("text", "")))
                continue

            if msg_type in ("execute_result", "display_data", "update_display_data"):
                data = content.get("data", {})
                if isinstance(data, dict) and "text/plain" in data:
                    rendered = str(data.get("text/plain", ""))
                    if rendered:
                        emit_output(job_id, "display", rendered + ("\n" if not rendered.endswith("\n") else ""))
                elif isinstance(data, dict) and data:
                    mime = ", ".join(sorted(str(item) for item in data.keys()))
                    emit_output(job_id, "system", f"[unsupported rich display MIME types: {mime}]\n")
                continue

            if msg_type == "clear_output":
                continue

            if msg_type == "error":
                traceback = content.get("traceback", [])
                text = "\n".join(str(item) for item in traceback)
                if text:
                    emit_output(job_id, "stderr", text + ("\n" if not text.endswith("\n") else ""))
                continue

            if msg_type == "status" and content.get("execution_state") == "idle" and isinstance(parent_id, str):
                execution = executions.get(parent_id)
                if execution is not None:
                    idle = execution["idle"]
                    if not idle.done():
                        idle.set_result(None)

    async def shell_pump() -> None:
        while not shutting_down:
            try:
                msg = await client.get_shell_msg(timeout=1.0)
            except Empty:
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not shutting_down:
                    emit({"type": "fatal", "message": f"shell channel failed: {exc}"})
                    await command_queue.put({"type": "shutdown"})
                return

            parent_id = msg.get("parent_header", {}).get("msg_id")
            if not isinstance(parent_id, str) or msg.get("msg_type") != "execute_reply":
                continue
            execution = executions.get(parent_id)
            if execution is None:
                continue
            reply = execution["reply"]
            if not reply.done():
                reply.set_result(msg)

    async def stdin_pump() -> None:
        nonlocal stdin_waiter, stdin_job_id
        while not shutting_down:
            try:
                msg = await client.get_stdin_msg(timeout=1.0)
            except Empty:
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not shutting_down:
                    emit({"type": "fatal", "message": f"stdin channel failed: {exc}"})
                    await command_queue.put({"type": "shutdown"})
                return

            if msg.get("msg_type") != "input_request":
                continue
            job_id = job_for_message(msg)
            if job_id is None:
                diagnostic("received input_request with unknown parent message; no reply was fabricated")
                continue

            content = msg.get("content", {})
            loop = asyncio.get_running_loop()
            stdin_waiter = loop.create_future()
            stdin_job_id = job_id
            emit(
                {
                    "type": "waiting_input",
                    "jobId": job_id,
                    "prompt": str(content.get("prompt", "")),
                    "password": bool(content.get("password", False)),
                }
            )
            try:
                value = await stdin_waiter
                client.input(value)
            finally:
                stdin_waiter = None
                stdin_job_id = None

    async def run_execute(job_id: str, code: str) -> None:
        nonlocal active_job_id, active_msg_id, active_task, stdin_waiter, stdin_job_id
        active_job_id = job_id
        loop = asyncio.get_running_loop()
        msg_id = client.execute(code, silent=False, store_history=True, allow_stdin=True, stop_on_error=True)
        active_msg_id = msg_id
        remember_active(msg_id, job_id)
        reply: asyncio.Future[dict[str, Any]] = loop.create_future()
        idle: asyncio.Future[None] = loop.create_future()
        executions[msg_id] = {"reply": reply, "idle": idle}

        try:
            shell_reply, _ = await asyncio.gather(reply, idle)
            content = shell_reply.get("content", {})
            status = content.get("status")
            if status == "ok":
                emit({"type": "done", "jobId": job_id, "ok": True})
            else:
                emit(
                    {
                        "type": "done",
                        "jobId": job_id,
                        "ok": False,
                        "error": {
                            "kind": str(content.get("ename", status or "kernel_error")),
                            "message": str(content.get("evalue", content.get("status", "kernel execution failed"))),
                        },
                    }
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            emit(
                {
                    "type": "done",
                    "jobId": job_id,
                    "ok": False,
                    "error": {"kind": type(exc).__name__, "message": str(exc)},
                }
            )
        finally:
            executions.pop(msg_id, None)
            remember_completed(msg_id)
            if stdin_waiter is not None and stdin_job_id == job_id and not stdin_waiter.done():
                stdin_waiter.cancel()
            if active_msg_id == msg_id:
                active_msg_id = None
            if active_job_id == job_id:
                active_job_id = None
            active_task = None

    async def monitor_liveness() -> None:
        while not shutting_down:
            await asyncio.sleep(1.0)
            try:
                alive = await manager.is_alive()
            except Exception as exc:
                emit({"type": "fatal", "message": f"kernel liveness check failed: {exc}"})
                await command_queue.put({"type": "shutdown"})
                return
            if not alive:
                emit({"type": "fatal", "message": "kernel exited unexpectedly"})
                await command_queue.put({"type": "shutdown"})
                return

    reader_task = asyncio.create_task(read_commands())
    monitor_task = asyncio.create_task(monitor_liveness())
    iopub_task = asyncio.create_task(iopub_pump())
    shell_task = asyncio.create_task(shell_pump())
    stdin_task = asyncio.create_task(stdin_pump())

    try:
        while True:
            message = await command_queue.get()
            message_type = message.get("type")

            if message_type == "execute":
                job_id = message.get("jobId")
                code = message.get("code")
                if not isinstance(job_id, str) or not isinstance(code, str):
                    emit(
                        {
                            "type": "done",
                            "jobId": str(job_id),
                            "ok": False,
                            "error": {"kind": "invalid_execute", "message": "execute requires string jobId and code"},
                        }
                    )
                    continue
                if active_task is not None:
                    emit(
                        {
                            "type": "done",
                            "jobId": job_id,
                            "ok": False,
                            "error": {"kind": "concurrent_execute", "message": "another evaluation is already active"},
                        }
                    )
                    continue
                active_task = asyncio.create_task(run_execute(job_id, code))
                continue

            if message_type == "stdin":
                job_id = message.get("jobId")
                data = message.get("data")
                if isinstance(data, str) and job_id == stdin_job_id and stdin_waiter is not None and not stdin_waiter.done():
                    stdin_waiter.set_result(data)
                else:
                    diagnostic("ignored stdin for a job that is not waiting for input")
                continue

            if message_type == "interrupt":
                if message.get("jobId") == active_job_id:
                    await manager.interrupt_kernel()
                continue

            if message_type == "shutdown":
                confirmed = await shutdown_kernel()
                emit({"type": "shutdown", "confirmed": confirmed})
                break

            emit({"type": "fatal", "message": "unknown control command"})
    finally:
        if not shutdown_done:
            await shutdown_kernel()
        if active_task is not None and not active_task.done():
            active_task.cancel()
            with suppress(asyncio.CancelledError):
                await active_task
        for task in (reader_task, monitor_task, iopub_task, shell_task, stdin_task):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        emit({"type": "fatal", "message": f"{type(exc).__name__}: {exc}"})
        raise
