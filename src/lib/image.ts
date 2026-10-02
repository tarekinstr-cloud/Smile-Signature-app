/** A picture made smaller for the floor plan: re-encoded as JPEG, its longest side at most `maxSide` pixels. */
export interface CompressedImage {
  blob: Blob
  width: number
  height: number
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image'))
    }
    img.src = url
  })
}

/**
 * Compresses a photo or 3D render of the hall before it is stored: a phone picture of several MB becomes a JPEG of a
 * few hundred KB. Transparent PNGs get a white background (JPEG has no transparency).
 */
export async function compressImage(file: Blob, maxSide = 1920, quality = 0.82): Promise<CompressedImage> {
  const img = await loadImage(file)
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.max(1, Math.round(img.naturalWidth * ratio))
  const height = Math.max(1, Math.round(img.naturalHeight * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('image')
  return { blob, width, height }
}

/**
 * Photo of an item (Paramètres > Photos des articles): longest side at most 512 px, WebP when the browser can encode it
 * (a few tens of KB), JPEG otherwise. Transparent areas become white.
 */
export async function compressPhoto(file: Blob, maxSide = 512): Promise<CompressedImage> {
  const img = await loadImage(file)
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.max(1, Math.round(img.naturalWidth * ratio))
  const height = Math.max(1, Math.round(img.naturalHeight * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)
  const encode = (type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  // Browsers that cannot write WebP (older Safari) return a PNG instead: JPEG is used then.
  let blob = await encode('image/webp', 0.8)
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg', 0.82)
  if (!blob) throw new Error('image')
  return { blob, width, height }
}
