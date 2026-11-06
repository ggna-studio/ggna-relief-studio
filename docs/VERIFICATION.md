# Kiểm chứng kỹ thuật 1.2.0

GGNA RELIEF STUDIO WEB 1.2.0 — KIỂM CHỨNG KỸ THUẬT
Ngày kiểm tra: 05/11/2026 (giờ Việt Nam). Kết quả kiểm chứng trước khi upload.

- Thương hiệu: GGNA. Logo/favicon SVG mới, giao diện graphite/mint.
- Đã thay toàn bộ thương hiệu sản phẩm cũ trong tài sản giao diện và mã app bằng GGNA.
- Mẫu heightmap hình học tạo bằng công thức, không phải đầu ra model; đã bỏ các ảnh mẫu thương hiệu cũ.
- Sáu model đã đối chiếu SHA256 với MODEL-MANIFEST.json, khớp toàn bộ.
- Giữ nguyên graph, checkpoint, LoRA, upscaler và attribution/giấy phép bên thứ ba. Không đổi tác giả model thành GGNA.
- Python 3.13.12, PyTorch 2.12.0+cu130, ComfyUI 0.26.0.
- GPU RTX 3060 12 GB: tác vụ nội bộ 512x512, draft 20 bước, seed 408416742087713 hoàn thành; nhận PNG 2048x2048. Log ComfyUI: 49.31 giây.
- 6 kiểm tra backend Python và 19 kiểm tra JS xử lý ảnh/workflow/API đã qua; TypeScript/Vite build đã qua.
- Giao diện thật: mở mẫu, xem 3D, xuất PNG grayscale 16-bit 2048x2048 thành công.
- Runtime/backend/ảnh/log/khóa/caches của lần thử được đặt ngoài thư mục phát hành; không đưa vào ZIP.
- UI chạy trong trình duyệt sẵn có, backend Python stdlib; không cần Node.js/Python cài ngoài khi dùng bộ đầy đủ.

Giới hạn: chưa kiểm tra máy Windows sạch hoặc mọi dòng GPU. Khách cần NVIDIA/driver tương thích, đủ RAM/VRAM và dung lượng SSD.
Phát hành bởi chủ dự án GGNA. Giữ giấy phép trong licenses và NOTICE; xác minh quyền phân phối/khai thác model trước khi chia sẻ cho khách.


KIỂM TRA FILE PHÁT HÀNH
GGNA-Relief-Web-Full-1.2.0-Windows-x64.zip: 17837663725 bytes; 49351 files; SHA256 4408fec17e7327f2683a789220fb474bafc315d34bcc09902756a29172796e75
GGNA-Relief-Studio-1.2.0-Source.zip: 460287 bytes; 42 files; SHA256 a1c6be1675e4f94765ffe7f3e48d38011872235c3b03d45dc56541e7c1d3c45f
Cả hai ZIP đã qua kiểm tra CRC toàn bộ bằng 7-Zip.
PNG 16-bit xuất từ giao diện: 2048x2048, grayscale một kênh, 41.246 mức xám.
