import { ImageResponse } from "next/og";

// Browser tab favicon. Next.js auto-registers this file as the
// site icon by file convention.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1F4D3F",
          color: "#F0E8D0",
          fontSize: 22,
          fontWeight: 700,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          borderRadius: 6,
          letterSpacing: -1,
        }}
      >
        S
      </div>
    ),
    size
  );
}
