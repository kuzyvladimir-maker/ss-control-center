import { ImageResponse } from "next/og";

// iOS / iPadOS Home Screen icon. Auto-registered by Next.js when this
// file is at app/apple-icon.tsx. 180×180 is what current Safari prefers;
// older devices downscale.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
          fontSize: 110,
          fontWeight: 700,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          letterSpacing: -4,
        }}
      >
        S
      </div>
    ),
    size
  );
}
