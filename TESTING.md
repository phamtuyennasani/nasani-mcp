# Kiểm thử NASANI MCP

Ngày kiểm thử: **12/11/2026**. Môi trường: macOS, Node.js 26.0.0, Codex CLI 0.167.0 và Claude Code 2.1.319. Đây là kết quả trên máy kiểm thử, không phải cam kết tương thích với mọi phiên bản client.

## Kiểm tra tự động

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

Một integration test dùng MCP SDK client thật, chạy qua STDIO, Streamable HTTP và local-to-remote bridge. Các nhánh kiểm tra gồm workflow, source validation/format, assets, Swiper, token/revoke, containment/symlink/hardlink, giới hạn bundle, lỗi mạng, sửa source đồng thời, rollback và installer không ghi đè cấu hình tùy biến. Test đã qua. Skill cũng đã qua `quick_validate.py` của skill-creator; npm pack dry run không chứa token, `.env`, `node_modules` hay demo khách hàng.

## Cài nhanh

Lệnh `setup` có menu chọn Codex, Claude Code hoặc cả hai; dùng thư mục hiện tại khi không truyền `--project`. Đã thử menu thực tế qua `npx` với gói `.tgz` trong Terminal, chọn `3` rồi Enter để cài cả hai vào dự án có dấu cách trong đường dẫn.

Test `test/setup.test.cjs` chạy với home/dự án tạm, cài cả hai client, giữ config không liên quan, chạy lại không đổi config, và từ chối xung đột ở Claude trước khi tạo config Codex. Test xóa bản tải tạm rồi dùng cấu hình đã cài khởi động MCP STDIO và gọi `nasani_environment` thành công. Runtime là bản copy cố định, không phải symlink tới cache tải xuống. Chưa kiểm thử cài nhanh trên Windows/Linux; trust MCP và OAuth Figma vẫn do người dùng thực hiện trong client.

## Cài skill qua skills CLI

Đã thử `skills` **1.8.1** với repo GitHub công khai:

```sh
npx skills add phamtuyennasani/nasani-mcp --list
npx skills add phamtuyennasani/nasani-mcp -g --agent codex claude-code --yes
```

Lệnh đầu nhận diện đúng một skill `nasani-figma`. Lệnh cài global được chạy với `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` và `XDG_CONFIG_HOME` trỏ tới thư mục tạm, không thay skill/config thật của người dùng. Assert xác nhận `SKILL.md` và `references/standalone.md` có đủ tại `~/.agents/skills/nasani-figma/`, Claude có symlink tới cùng skill, và nội dung khớp source repo.

Assert cũng xác nhận không có runtime NASANI, MCP config hay agent được tạo ngay bởi `skills add`. Bản thân CLI khi chạy trong phiên Codex có thể tự phát hiện Codex và bỏ menu; `--agent codex claude-code` chỉ định rõ cả hai client.

Skill có thêm helper `scripts/nasani.cjs` cho lần dùng đầu khi chưa có tool native. Helper gọi installer và dùng MCP SDK client thật qua STDIO, không gọi engine thay cho MCP. Test `test/setup.test.cjs` kiểm tra helper đăng ký MCP vào một dự án sạch, gọi environment đúng root, format rồi validate source thật, chạy lại giữ config, trả lỗi khi thoát root, và giữ nguyên cấu hình NASANI tùy chỉnh. Tên tool không hợp lệ/JSON không phải object bị chặn trước khi ghi config. Helper không làm tool native xuất hiện trong phiên client đang chạy; các kiểm tra trên dùng shell helper cho đến khi client nạp lại MCP.

Đã chạy riêng helper với home hoàn toàn mới, chưa có runtime, dùng đường dẫn dự án có dấu cách. Helper tải NASANI từ GitHub, tạo runtime cố định và project config Codex, rồi `nasani_environment` trả `ok: true`, `mode: local` và đúng project root ngay trong cùng invocation. Không ghi config Codex global hoặc config Claude ngoài lựa chọn. Đây là kiểm thử helper/installer/MCP, không phải bằng chứng mọi model sẽ tự thực thi đúng hướng dẫn skill hay mọi client sẽ tự nạp lại tool.

## Tinh gọn các lần gọi tiếp theo

Test setup thay tạm module setup trong runtime thử nghiệm bằng lỗi bắt buộc, rồi xác nhận helper vẫn gọi environment/format thành công, không in log setup và không đổi config. Test còn kiểm tra cấu hình bị sửa thành NASANI tùy chỉnh phải bị từ chối, symlink config bị chặn, cấu hình bị xóa được đăng ký lại, và cả Codex/Claude đều có luồng gọi lại không chạy setup. Mọi thay đổi này nằm trong home/dự án tạm.

Luồng standalone nay hướng dẫn gọi format trực tiếp sau khi có source/assets, vì tool đã kiểm tra asset và validate trước/sau. Integration test xác nhận format từ chối sai `content_width` hoặc thiếu asset mà không đổi source; các tool validate/assets riêng vẫn hoạt động. Engine, schema, kiểm tra containment, concurrent edit và rollback không được nới lỏng. Kiểm thử tự động không chứng minh mọi model sẽ tránh các bước thừa; phần once-per-session được quy định trong skill, agent và mô tả MCP.

## Dữ liệu Figma thật

Trong phiên Codex đang làm việc, Figma MCP chính thức đã đọc thành công một frame Petshop **1920 × 7490 px** do người dùng cung cấp. AI của phiên đọc context/screenshot, lấy assets và ghi trực tiếp `petshop/index.html`, `petshop/style.css`, `petshop/assets/` vào một dự án demo riêng. Không tạo ZIP. File Figma, ảnh khách hàng và bản demo không được đưa vào repository này.

Output có 11 vùng: header, hero, giới thiệu, giá trị, dịch vụ, combo, sản phẩm, gallery, tin tức, liên hệ và footer. `content_width: 1230` tương ứng max-width của wrapper, đã gồm padding hai bên. Sau format cuối, kết quả tool validator và asset audit đều qua, nhận diện 11 vùng và 55 đường dẫn asset duy nhất. Số đếm lấy từ JSON tool result, không dùng số đếm trong lời tóm tắt của model.

Các lỗi dữ liệu thật đã gặp và xử lý trong demo:

- Một số URL mang đuôi PNG nhưng trả JPEG: kiểm tra signature rồi chuẩn hóa đúng định dạng.
- SVG chính thức có phần vượt allowlist: rasterize đúng artwork bằng renderer đã có, giữ bản gốc; không nới policy của engine.
- Ảnh trang trí nhô ra ngoài wrapper gây cuộn ngang ở laptop: giới hạn phần tràn tại các vùng chứa ảnh rồi kiểm tra lại.

## Client thật

### Lượt Hannie — 12/11/2026

Đã đọc frame Hannie **1920 × 1080 px** bằng Figma MCP chính thức trong phiên Codex: tạo session theo yêu cầu của tool, gọi `get_design_context` trực tiếp rồi tải asset. Không gọi whoami/health/auth preflight. AI của phiên ghi `index.html`, `style.css` và asset local vào một dự án demo riêng; MCP SDK client thật khởi động NASANI từ source repo qua STDIO và gọi environment/format. Lượt format cuối trả `ok: true`, `formatted: true`, `errors: []`; không tạo ZIP.

Kiểm thử này phát hiện formatter xóa `id`, `aria-*`, `role` và `tabindex` đã được validator chấp nhận. Đã bỏ bước xóa thuộc tính; integration test xác nhận các thuộc tính và liên kết `aria-labelledby` được giữ sau `nasani_format`. Test hồi quy thất bại trước sửa và qua sau sửa; `npm test` qua **2/2**. Không nới allowlist của validator.

Chrome được kiểm tra qua browser extension ở **320, 390, 768, 1024, 1025, 1050, 1100, 1230, 1280, 1920 px**. Sau sửa CSS demo, không cuộn ngang, không vùng nội dung được đo vượt mép trang, không tràn nội bộ tại các nhóm text/gallery/card được kiểm tra, không ảnh lỗi và không link thiếu tên truy cập. Font local tải đủ; console không ghi warning/error trong lượt quan sát. Đã lưu JSON đo đạc và ảnh desktop/mobile cùng demo, so sánh trực quan với screenshot Figma. Không dùng ảnh toàn frame thay cho HTML.

Đây là kiểm thử Codex + Figma chính thức + NASANI STDIO, chưa phải một lượt Claude độc lập với frame này. Menu/search/CTA là giao diện static, chưa có nội dung đích hoặc backend; frame không có carousel nên không kiểm thử Swiper bằng dữ liệu Hannie. Không tuyên bố pixel-perfect. Demo và artwork khách hàng không đưa vào repo.

| Client | Kết quả đã quan sát |
| --- | --- |
| Codex CLI | Gọi được environment/workflow và chạy thành công validate → format → validate lại → assets qua MCP STDIO. Lượt đầu bị chính sách approval `never` chặn format; lượt cuối đặt quyền cho đúng `nasani_format` trong cấu hình riêng của invocation rồi cả bốn tool đều trả `ok: true`. |
| Claude Code | Gọi được environment/workflow; chạy thành công validate → format → validate lại → assets trên demo thật, với danh sách tool được cho phép cho lượt chạy. Không có permission denial. |

Các lượt CLI dùng cấu hình MCP truyền rõ cho phiên chạy. Project config đã được installer tạo nhưng **không được coi là tự phát hiện thành công**: Codex báo project config bị bỏ qua khi dự án chưa trusted; Claude yêu cầu chấp thuận project MCP. Không sửa cấu hình trust hoặc đăng nhập global để làm test qua. Người cài phải hoàn tất các bước trust/approve theo README. Tool ghi source vẫn khai báo là có thay đổi dữ liệu.

Lượt Codex cuối dùng override `-c 'mcp_servers.nasani.tools.nasani_format.approval_mode="approve"'` chỉ cho tool format được ủy quyền trên demo, không tự nới quyền mọi tool. Tùy chọn này phụ thuộc phiên bản Codex; khi dùng tương tác, ưu tiên luồng chấp thuận của client. Một lượt retry còn gặp lỗi stream của provider trước khi thành công; không coi lỗi provider đó là lỗi MCP.

Figma được đọc bằng kết nối chính thức trong phiên thực hiện triển khai; không có bằng chứng rằng các subprocess Codex và Claude tự đăng nhập hoặc chia sẻ phiên Figma cho nhau. NASANI không chuyển OAuth token giữa các MCP.

## Kiểm tra trình duyệt

Demo chạy qua HTTP local trong Chrome headless bằng Playwright đã có trên máy. Một script assert độc lập được giữ cùng demo để chạy lại. Các độ rộng **320, 390, 768, 900, 1024, 1100, 1280, 1440, 1920 px** đều qua:

- Không cuộn ngang; đủ 11 vùng.
- Không ảnh lỗi, request lỗi hoặc JavaScript page error.
- Tài nguyên của trang tải từ cùng server local.

Đã lưu ảnh render desktop/mobile và so sánh với screenshot nguồn. Đây là kiểm tra bố cục thực tế, không phải điểm số pixel similarity tự động.

## Giới hạn còn lại

- Chưa có hai font riêng của thiết kế (`1FTV VIP Cute Dino`, `1FTV School Book New`); demo dùng font thay thế. Typography, một số trang trí và khoảng cách chưa trùng hoàn toàn Figma. Không tuyên bố pixel-perfect.
- Đây là demo giao diện static. Form chưa gửi dữ liệu; tab sản phẩm, giỏ hàng và nội dung đích chưa có backend. Luồng carousel runtime riêng chưa được kiểm thử với thiết kế này.
- HTTP/bridge đã qua test local; Docker, TLS và triển khai host thật chưa được chạy. Chưa publish npm registry. Phân phối hiện tại bằng source Git hoặc gói `.tgz` nội bộ.
- Validator standalone không kiểm tra React/Vue/Laravel. Tích hợp vào ứng dụng phải dùng cấu trúc và bộ kiểm tra của chính ứng dụng đó.
