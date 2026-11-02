import { useEffect, useState } from "react"

export type ThemePreference = "system" | "light" | "dark"

const STORAGE_KEY = "fp.theme"

const readStored = (): ThemePreference => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (raw === "light" || raw === "dark" || raw === "system") return raw
	} catch {
		// Private mode / blocked storage: stay on system.
	}
	return "system"
}

const applyTheme = (preference: ThemePreference) => {
	const root = document.documentElement
	if (preference === "system") {
		root.removeAttribute("data-theme")
		return
	}
	root.setAttribute("data-theme", preference)
}

/** Cycles system → light → dark → system. Persists when storage is available. */
export function useTheme(): {
	preference: ThemePreference
	cycle: () => void
	label: string
} {
	const [preference, setPreference] = useState<ThemePreference>(() => {
		if (typeof document === "undefined") return "system"
		const stored = readStored()
		applyTheme(stored)
		return stored
	})

	useEffect(() => {
		applyTheme(preference)
		try {
			localStorage.setItem(STORAGE_KEY, preference)
		} catch {
			// Ignore persistence failures.
		}
	}, [preference])

	const cycle = () => {
		setPreference((current) =>
			current === "system" ? "light" : current === "light" ? "dark" : "system",
		)
	}

	const label =
		preference === "system"
			? "Theme: system"
			: preference === "light"
				? "Theme: light"
				: "Theme: dark"

	return { preference, cycle, label }
}
