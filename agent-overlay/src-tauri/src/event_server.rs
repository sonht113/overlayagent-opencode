//! Localhost HTTP bridge for OpenCode / Python monitor events.
//!
//! - POST /event  → emit Tauri events + ring buffer
//! - GET  /health → liveness
//! - GET  /events → last N events (diagnostics)

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Read;
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server, StatusCode};

const DEFAULT_PORT: u16 = 9876;
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_EVENT_LOG: usize = 30;

static EVENT_LOG: Mutex<Option<VecDeque<Value>>> = Mutex::new(None);

#[derive(Debug, Deserialize)]
struct IncomingEvent {
    event: String,
    #[allow(dead_code)]
    timestamp: Option<String>,
    data: Option<Value>,
}

fn with_log<F, R>(f: F) -> R
where
    F: FnOnce(&mut VecDeque<Value>) -> R,
{
    let mut guard = EVENT_LOG.lock().expect("event log lock");
    if guard.is_none() {
        *guard = Some(VecDeque::with_capacity(MAX_EVENT_LOG));
    }
    f(guard.as_mut().unwrap())
}

fn push_log(event: &str, data: &Value) {
    let entry = json!({
        "ts": chrono_like_now(),
        "event": event,
        "data": data,
    });
    with_log(|q| {
        if q.len() >= MAX_EVENT_LOG {
            q.pop_front();
        }
        q.push_back(entry);
    });
}

/// Lightweight timestamp without extra crate.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

pub fn resolve_port() -> u16 {
    std::env::var("AGENT_OVERLAY_EVENT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub fn spawn(app: AppHandle, port: u16) {
    thread::Builder::new()
        .name("opencode-event-server".into())
        .spawn(move || run_server(app, port))
        .expect("failed to spawn event server thread");
}

fn run_server(app: AppHandle, port: u16) {
    let addr = format!("127.0.0.1:{port}");
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[event_server] failed to bind {addr}: {e}");
            eprintln!("[event_server] OpenCode events will not be received (port busy or blocked)");
            return;
        }
    };

    eprintln!("[event_server] listening on http://{addr}/event");
    let _ = app.emit(
        "opencode://server_ready",
        json!({ "port": port, "url": format!("http://{addr}/event") }),
    );

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();
        let path = url.split('?').next().unwrap_or(&url);

        let response = match (method, path) {
            (Method::Get, "/health") => json_response(
                StatusCode(200),
                json!({
                    "ok": true,
                    "service": "agent-overlay",
                    "port": port
                }),
            ),
            (Method::Get, "/events") => {
                let events: Vec<Value> = with_log(|q| q.iter().cloned().collect());
                json_response(StatusCode(200), json!({ "ok": true, "events": events }))
            }
            (Method::Post, "/event") => handle_event(&app, &mut request),
            (Method::Options, _) => Response::from_string("")
                .with_status_code(StatusCode(204))
                .with_header(cors_header()),
            _ => json_response(
                StatusCode(404),
                json!({ "ok": false, "error": "not_found" }),
            ),
        };

        if let Err(e) = request.respond(response) {
            eprintln!("[event_server] respond error: {e}");
        }
    }
}

fn handle_event(
    app: &AppHandle,
    request: &mut tiny_http::Request,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut body = Vec::new();
    let reader = request.as_reader();
    let mut limited = reader.take(MAX_BODY_BYTES as u64 + 1);
    if let Err(e) = limited.read_to_end(&mut body) {
        eprintln!("[event_server] read body error: {e}");
        return json_response(
            StatusCode(400),
            json!({ "ok": false, "error": "read_failed" }),
        );
    }
    if body.len() > MAX_BODY_BYTES {
        return json_response(
            StatusCode(413),
            json!({ "ok": false, "error": "payload_too_large" }),
        );
    }

    let parsed: IncomingEvent = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[event_server] invalid JSON: {e}");
            return json_response(
                StatusCode(400),
                json!({ "ok": false, "error": "invalid_json" }),
            );
        }
    };

    let data = parsed.data.unwrap_or_else(|| json!({}));
    let emit_name = match parsed.event.as_str() {
        "generation_start" => "opencode://generation_start",
        "generation_end" => "opencode://generation_end",
        "tokens_update" => "opencode://tokens_update",
        other => {
            eprintln!("[event_server] unknown event: {other}");
            return json_response(
                StatusCode(400),
                json!({ "ok": false, "error": "unknown_event", "event": other }),
            );
        }
    };

    push_log(&parsed.event, &data);

    if let Err(e) = app.emit(emit_name, data) {
        eprintln!("[event_server] emit {emit_name} failed: {e}");
        return json_response(
            StatusCode(500),
            json!({ "ok": false, "error": "emit_failed" }),
        );
    }

    eprintln!("[event_server] emitted {emit_name}");
    json_response(
        StatusCode(200),
        json!({ "ok": true, "event": parsed.event }),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = value.to_string();
    Response::from_string(body)
        .with_status_code(status)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("valid header"),
        )
        .with_header(cors_header())
}

fn cors_header() -> Header {
    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).expect("valid header")
}
