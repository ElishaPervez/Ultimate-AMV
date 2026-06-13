use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// Color of the screen pixel under the mouse cursor, as `#rrggbb`.
///
/// Backs the theme color picker's eyedropper: WebView2 ships the EyeDropper
/// API surface but `open()` rejects instantly (the browser-side picking UI is
/// not implemented), so the frontend overlays the window and samples through
/// this command on pointer move / click instead.
#[tauri::command]
pub(crate) fn sample_screen_color() -> Result<String, String> {
    unsafe {
        let mut pt = POINT::default();
        GetCursorPos(&mut pt).map_err(|e| format!("GetCursorPos failed: {e}"))?;
        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return Err("GetDC failed".into());
        }
        let color = GetPixel(hdc, pt.x, pt.y);
        ReleaseDC(None, hdc);
        let v = color.0;
        if v == CLR_INVALID {
            return Err(format!("GetPixel failed at {}, {}", pt.x, pt.y));
        }
        // COLORREF is 0x00bbggrr
        Ok(format!(
            "#{:02x}{:02x}{:02x}",
            v & 0xff,
            (v >> 8) & 0xff,
            (v >> 16) & 0xff
        ))
    }
}
