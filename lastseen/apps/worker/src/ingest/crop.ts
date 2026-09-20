type Box = readonly [number, number, number, number];

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pixel rectangle for a normalized [x,y,w,h] box, grown by `margin` (fraction of the box size) and clamped. */
export function cropRect(box: Box, imgW: number, imgH: number, margin = 0.25): CropRect {
  const [bx, by, bw, bh] = box;
  const left = Math.max(0, Math.floor((bx - bw * margin) * imgW));
  const top = Math.max(0, Math.floor((by - bh * margin) * imgH));
  const right = Math.min(imgW, Math.ceil((bx + bw * (1 + margin)) * imgW));
  const bottom = Math.min(imgH, Math.ceil((by + bh * (1 + margin)) * imgH));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function shouldCrop(w: number, h: number, minPixels: number): boolean {
  return w > 0 && h > 0 && w * h >= minPixels;
}

export interface Cropper {
  /** returns the cropped JPEG as base64, or null when cropping is not possible here */
  crop(jpegBase64: string, imgW: number, imgH: number, rect: CropRect): Promise<string | null>;
}

/** Workers Images binding. `trim` removes pixels from each edge. Local `wrangler dev` only supports a subset, so failures return null. */
export class ImagesCropper implements Cropper {
  constructor(private readonly images: ImagesBinding) {}
  async crop(jpegBase64: string, imgW: number, imgH: number, r: CropRect): Promise<string | null> {
    try {
      const bytes = Uint8Array.from(atob(jpegBase64), (c) => c.charCodeAt(0));
      const stream = new Response(bytes).body!;
      const out = await this.images
        .input(stream)
        .transform({ trim: { top: r.top, left: r.left, right: imgW - r.left - r.width, bottom: imgH - r.top - r.height } })
        .output({ format: "image/jpeg", quality: 85 });
      const res = out.response();
      const buf = new Uint8Array(await res.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    } catch {
      return null;
    }
  }
}

/** Mock/offline cropper: hands back the input so the crop path is exercised without an image decoder. */
export class PassthroughCropper implements Cropper {
  async crop(jpegBase64: string): Promise<string | null> {
    return jpegBase64;
  }
}

/** Used when no cropper is available. */
export class NoCropper implements Cropper {
  async crop(): Promise<string | null> {
    return null;
  }
}
