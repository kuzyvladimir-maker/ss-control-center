"use client";

import { useCallback, useEffect } from "react";
import { Upload, X } from "lucide-react";

const MAX_IMAGES = 5;

export interface ImageItem {
  id: string;
  base64: string;
  preview: string;
}

interface ImageUploaderProps {
  images: ImageItem[];
  onImagesChange: (images: ImageItem[]) => void;
  disabled?: boolean;
}

export default function ImageUploader({
  images,
  onImagesChange,
  disabled,
}: ImageUploaderProps) {
  const addFile = useCallback(
    (file: File) => {
      if (images.length >= MAX_IMAGES) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        const base64 = dataUrl.split(",")[1];
        onImagesChange([
          ...images,
          { id: crypto.randomUUID(), base64, preview: dataUrl },
        ].slice(0, MAX_IMAGES));
      };
      reader.readAsDataURL(file);
    },
    [images, onImagesChange]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
      for (const f of arr.slice(0, MAX_IMAGES - images.length)) {
        addFile(f);
      }
    },
    [addFile, images.length]
  );

  const removeImage = (id: string) => {
    onImagesChange(images.filter((img) => img.id !== id));
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      addFiles(e.dataTransfer.files);
    },
    [addFiles, disabled]
  );

  // Global paste handler
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) addFile(file);
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [addFile, disabled]);

  return (
    <div>
      {/* Thumbnails */}
      {images.length > 0 && (
        <div className="mb-3 flex gap-2 flex-wrap">
          {images.map((img, idx) => (
            <div key={img.id} className="group relative">
              <img
                src={img.preview}
                alt={`Screenshot ${idx + 1}`}
                className="h-20 w-20 rounded-md border border-slate-200 object-cover"
              />
              <button
                onClick={() => removeImage(img.id)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X size={12} />
              </button>
              <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white">
                {idx + 1}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => {
          if (disabled || images.length >= MAX_IMAGES) return;
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.multiple = true;
          input.onchange = (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files) addFiles(files);
          };
          input.click();
        }}
        className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors ${
          disabled || images.length >= MAX_IMAGES
            ? "border-slate-200 bg-slate-50 cursor-not-allowed opacity-50"
            : "border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50"
        }`}
      >
        <Upload className="mb-1 text-slate-400" size={24} />
        <p className="text-xs text-slate-600">
          {images.length >= MAX_IMAGES
            ? "Maximum images reached"
            : "Drag & drop, click, or Ctrl+V to add images"}
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5">
          PNG, JPG, WEBP — up to {MAX_IMAGES} images
        </p>
      </div>

      <p className="mt-1 text-right text-[10px] text-slate-400">
        {images.length}/{MAX_IMAGES}
      </p>
    </div>
  );
}
