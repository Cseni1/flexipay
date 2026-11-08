/**
 * CCR-46: phone photos are often 3–8 MB. Before upload, a large JPEG/PNG/WEBP is redrawn at
 * most 2400 px on its longest side as a JPEG (quality 0.85), which keeps ID text readable
 * and stays well under the 5 MB limit. PDFs, HEIC and small files are sent unchanged.
 */
export const SHRINK_ABOVE_BYTES = 1_500_000
const MAX_SIDE = 2400

export function needsShrinking(file: { type: string; size: number }): boolean {
	return (
		file.size > SHRINK_ABOVE_BYTES &&
		["image/jpeg", "image/png", "image/webp"].includes(file.type)
	)
}

export function scaledSize(
	width: number,
	height: number,
	maxSide = MAX_SIDE,
): { width: number; height: number } {
	const longest = Math.max(width, height)
	if (longest <= maxSide) return { width, height }
	const ratio = maxSide / longest
	return {
		width: Math.round(width * ratio),
		height: Math.round(height * ratio),
	}
}

export async function shrinkPhoto(file: Blob): Promise<Blob> {
	if (
		!needsShrinking(file) ||
		typeof createImageBitmap !== "function" ||
		typeof document === "undefined"
	) {
		return file
	}
	try {
		const bitmap = await createImageBitmap(file)
		const size = scaledSize(bitmap.width, bitmap.height)
		const canvas = document.createElement("canvas")
		canvas.width = size.width
		canvas.height = size.height
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0, size.width, size.height)
		bitmap.close()
		const out = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.85),
		)
		return out && out.size < file.size ? out : file
	} catch {
		return file
	}
}
