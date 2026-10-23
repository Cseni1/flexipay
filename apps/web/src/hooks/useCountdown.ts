import { useEffect, useState } from "react"

interface Countdown {
	remainingMs: number
	expired: boolean
	label: string
}

const formatRemaining = (remainingMs: number): string => {
	const totalSeconds = Math.ceil(remainingMs / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/** Counts down to the quote's validUntil; an invalid or missing timestamp is treated as expired. */
export function useCountdown(validUntil: string | null): Countdown {
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (!validUntil) return
		setNow(Date.now())
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [validUntil])

	const end = validUntil ? Date.parse(validUntil) : Number.NaN
	const remainingMs = Number.isNaN(end) ? 0 : Math.max(0, end - now)
	return {
		remainingMs,
		expired: remainingMs <= 0,
		label: formatRemaining(remainingMs),
	}
}
