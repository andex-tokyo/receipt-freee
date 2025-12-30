use anyhow::Result;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

const OAUTH_CALLBACK_PORT: u16 = 17890;

pub fn start_oauth_server() -> Result<String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", OAUTH_CALLBACK_PORT))?;

    // タイムアウトを設定（5分）
    listener.set_nonblocking(false)?;

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let buf_reader = BufReader::new(&stream);
                let request_line = buf_reader.lines().next();

                if let Some(Ok(line)) = request_line {
                    if line.starts_with("GET /callback") {
                        // URLからcodeパラメータを抽出
                        if let Some(code) = extract_code_from_request(&line) {
                            // 成功レスポンスを返す
                            let html = r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>認証完了</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            text-align: center;
            background: white;
            padding: 3rem;
            border-radius: 1rem;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        h1 { color: #22c55e; margin-bottom: 1rem; }
        p { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>認証が完了しました</h1>
        <p>このウィンドウを閉じて、アプリに戻ってください。</p>
    </div>
</body>
</html>"#;

                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\n\r\n{}",
                                html.len(),
                                html
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();

                            return Ok(code);
                        } else if line.contains("error=") {
                            // エラーレスポンス
                            let html = r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>認証エラー</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: #f5f5f5;
        }
        .container {
            text-align: center;
            background: white;
            padding: 3rem;
            border-radius: 1rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }
        h1 { color: #ef4444; }
        p { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>認証に失敗しました</h1>
        <p>もう一度お試しください。</p>
    </div>
</body>
</html>"#;

                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\n\r\n{}",
                                html.len(),
                                html
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();

                            return Err(anyhow::anyhow!("OAuth authentication was denied"));
                        }
                    }
                }
            }
            Err(e) => {
                return Err(anyhow::anyhow!("Failed to accept connection: {}", e));
            }
        }
    }

    Err(anyhow::anyhow!("OAuth server stopped unexpectedly"))
}

fn extract_code_from_request(request_line: &str) -> Option<String> {
    // GET /callback?code=XXXX HTTP/1.1
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let path = parts[1];
    if !path.starts_with("/callback?") {
        return None;
    }

    let query = path.strip_prefix("/callback?")?;
    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
            if key == "code" {
                return Some(value.to_string());
            }
        }
    }

    None
}
