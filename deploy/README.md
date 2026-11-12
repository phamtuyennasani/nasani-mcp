# NASANI host từ xa — tùy chọn

Luồng mặc định là MCP local dùng ngay phiên Codex/Claude, không cần phần này. Chỉ triển khai server riêng nếu bạn chủ động muốn xử lý output trên host. Các lệnh dưới chạy tại thư mục gốc project NASANI.

## 1. Chạy thử host trên máy

Chạy ở project NASANI. Các lệnh `keygen` in token **một lần** ra terminal; gửi riêng cho đúng thành viên, không đưa vào chat AI hoặc Git:

```sh
node bin/nasani.cjs keygen --access-file data/access.json --member developer-01
node bin/nasani.cjs serve \
  --access-file data/access.json \
  --url http://127.0.0.1:8787/mcp
```

Mở terminal khác, lưu token vừa nhận bằng prompt ẩn. Lệnh dưới dùng Bash trên macOS/Linux; không đặt token thật vào câu lệnh:

```sh
bash -c 'read -r -s -p "NASANI token: " nasani_token; printf "\n" >&2; printf "%s" "$nasani_token" | node bin/nasani.cjs token; unset nasani_token'

node bin/nasani.cjs install --client codex \
  --project /duong-dan-tuyet-doi/du-an-cua-ban \
  --mode bridge --url http://127.0.0.1:8787/mcp
```

`token` lưu vào `~/.config/nasani/token`, quyền `600`, từ chối ghi đè file cũ. Có thể chỉ định `--token-file /duong-dan-rieng/token` cho cả `token` và `install` nếu dùng nhiều host. Khi đổi token, xóa đúng file cũ rồi lưu lại. Bridge cũng hỗ trợ `NASANI_TOKEN` hoặc `NASANI_TOKEN_FILE` từ môi trường AI client; token file tiện hơn cho ứng dụng desktop. Không lưu token trong file config của dự án.

Nếu đã cài local trong dự án này, sửa/xóa **entry `mcp_servers.nasani` hoặc `mcpServers.nasani`** cũ trước khi chuyển sang bridge. Giữ các entry MCP khác.

## 2. Đưa lên VPS / host riêng

Hỗ trợ Node process lâu dài hoặc Docker; không dùng shared PHP hosting chỉ chạy request ngắn. Với cấu hình Docker kèm theo: chuẩn bị VPS Linux có Docker Engine + Compose plugin, DNS tên miền trỏ tới VPS và mở cổng 80/443. Ngân sách ban đầu của cấu hình là 2 CPU / 2 GiB RAM cho service NASANI; nên dùng VPS có RAM dư cho OS và proxy, rồi đo theo output thực tế.

Copy **toàn bộ project NASANI** lên một thư mục riêng, ví dụ `/opt/nasani-mcp`. Không cần đưa dự án của thành viên lên host. Tại thư mục đó:

```sh
cp .env.example .env
# Sửa NASANI_DOMAIN trong .env thành tên miền thật, không có https:// và /mcp.

mkdir -p data
sudo chown 1000:1000 data
sudo chmod 700 data
docker compose build
```

Mount `data` của service chạy thường là read-only. Tạo/quản lý token bằng lệnh Node trên host (`npm ci --ignore-scripts` trước), hoặc dùng container quản trị sau với mount riêng có quyền ghi:

```sh
docker compose run --rm --no-deps \
  -v "$PWD/data:/admin-data" nasani \
  node bin/nasani.cjs keygen --access-file /admin-data/access.json --member developer-01

docker compose up -d
docker compose ps
curl --fail https://TEN-MIEN-CUA-BAN/healthz
```

Container dùng UID/GID 1000 (`node`); token file được tạo với quyền `600`. Nếu tạo file bằng Node trên host thay vì container, đặt owner `1000:1000` cho cả `data` và `data/access.json` để container đọc được. Chỉ chạy **một** cách `keygen` để tạo cùng một member. Caddy cấp/gia hạn TLS cho tên miền đã cấu hình. NASANI không publish cổng 8787 ra Internet; proxy gọi nó trong mạng Compose. `data/` chứa hash SHA-256 của token, không chứa token nguyên bản. Thư mục được mount read-only vào runtime; job nằm trong tmpfs và bị xóa khi xử lý xong/lỗi. Không bật log request body hoặc Authorization ở proxy bổ sung. Khi cập nhật code, chạy lại `docker compose up -d --build`; giữ nguyên `data/` và các volume Caddy.

Thêm thành viên bằng lệnh container quản trị phía trên với member mới. Thu hồi token có hiệu lực cho request tiếp theo, không cần restart:

```sh
docker compose run --rm --no-deps \
  -v "$PWD/data:/admin-data" nasani \
  node bin/nasani.cjs revoke --access-file /admin-data/access.json --member developer-01
```

Muốn cấp lại token: revoke member rồi keygen lại. Quản lý file access tuần tự bằng một admin; hiện chưa có UI hoặc khóa giao dịch cho nhiều admin cùng ghi. Không dùng chung một token cho mọi người.

Nếu chạy trực tiếp bằng Node, dùng process manager của host và reverse proxy HTTPS:

```sh
NASANI_ACCESS_FILE=/duong-dan-rieng/access.json \
NASANI_PUBLIC_URL=https://TEN-MIEN-CUA-BAN/mcp \
node bin/nasani.cjs serve
```

Mặc định bind `127.0.0.1:8787`. Chỉ đặt `NASANI_HOST=0.0.0.0` khi firewall/proxy hoặc mạng container đã giới hạn truy cập. Proxy cần giữ nguyên Host công khai, cho request tới 112 MiB và timeout trên 60 giây. HTTP chỉ được dùng với URL loopback khi thử local.

## 3. Mỗi thành viên cài vào dự án riêng

Thành viên nhận source project NASANI này hoặc gói `.tgz` từ admin, chạy `npm ci --ignore-scripts` trong thư mục NASANI, lưu token của mình bằng lệnh `token` ở bước 1, rồi:

```sh
node bin/nasani.cjs install --client codex \
  --project /duong-dan-tuyet-doi/du-an-rieng \
  --mode bridge --url https://TEN-MIEN-CUA-BAN/mcp
```

Claude Code dùng `--client claude`. Cài vào mỗi dự án cần dùng, sau đó mở lại AI client. Các thành viên dùng chung host engine nhưng làm việc trên source riêng; mỗi request có thư mục job riêng, không có workspace dùng chung trên server. Figma đăng nhập riêng trong MCP/plugin chính thức của từng client; không lưu tài khoản Figma trên host NASANI.

Nếu muốn đăng ký HTTP trực tiếp thay vì bridge, Codex có thể dùng entry:

```toml
[mcp_servers.nasani]
url = "https://TEN-MIEN-CUA-BAN/mcp"
bearer_token_env_var = "NASANI_TOKEN"
```

Chế độ này không đọc/ghi file trên máy developer. AI phải truyền bundle và tự áp dụng source trả về; thường tốn context hơn bridge. Với Claude hoặc AI client khác, dùng Streamable HTTP và header `Authorization: Bearer …` lấy từ biến môi trường theo client. Server NASANI hiện dùng token do admin cấp, chưa triển khai browser OAuth/login hay dynamic client registration.

