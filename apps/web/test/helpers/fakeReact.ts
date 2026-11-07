/**
 * Minimal synchronous stand-in for React's hook runtime, so hook decision logic can be
 * unit-tested in Node without a DOM or @testing-library. Use from a test file with:
 *
 *   vi.mock("react", () => import("./helpers/fakeReact.ts"))
 *
 * Supports useState, useEffect, useCallback, useMemo, useRef, useContext/use and
 * createContext. Effects run synchronously after each render; a setState during render or
 * effects re-renders once the current pass finishes (like React's batching).
 */

type Deps = readonly unknown[] | undefined

type EffectSlot = {
	deps: Deps
	cleanup?: (() => void) | void
}

type Instance = {
	hooks: unknown[]
	pendingEffects: Array<{ index: number; run: () => (() => void) | void }>
	render: () => void
	rendering: boolean
	dirty: boolean
	unmounted: boolean
}

let current: Instance | null = null
let hookIndex = 0

const active = (): Instance => {
	if (!current) throw new Error("fakeReact hook called outside renderHook")
	return current
}

const depsChanged = (prev: Deps, next: Deps): boolean => {
	if (!prev || !next) return true
	if (prev.length !== next.length) return true
	return prev.some((value, i) => !Object.is(value, next[i]))
}

type SetState<T> = (next: T | ((prev: T) => T)) => void

export function useState<T>(initial: T | (() => T)): [T, SetState<T>] {
	const inst = active()
	const index = hookIndex++
	if (!(index in inst.hooks)) {
		const slot: { value: T; set?: SetState<T> } = {
			value: typeof initial === "function" ? (initial as () => T)() : initial,
		}
		slot.set = (next) => {
			if (inst.unmounted) return
			const value =
				typeof next === "function" ? (next as (prev: T) => T)(slot.value) : next
			if (Object.is(value, slot.value)) return
			slot.value = value
			inst.render()
		}
		inst.hooks[index] = slot
	}
	const slot = inst.hooks[index] as { value: T; set: SetState<T> }
	return [slot.value, slot.set]
}

export function useEffect(run: () => (() => void) | void, deps?: Deps): void {
	const inst = active()
	const index = hookIndex++
	const slot = inst.hooks[index] as EffectSlot | undefined
	if (!slot || depsChanged(slot.deps, deps)) {
		inst.hooks[index] = { deps, cleanup: slot?.cleanup }
		inst.pendingEffects.push({ index, run })
	}
}

export const useLayoutEffect = useEffect

export function useMemo<T>(factory: () => T, deps: Deps): T {
	const inst = active()
	const index = hookIndex++
	const slot = inst.hooks[index] as { deps: Deps; value: T } | undefined
	if (!slot || depsChanged(slot.deps, deps)) {
		const value = factory()
		inst.hooks[index] = { deps, value }
		return value
	}
	return slot.value
}

export function useCallback<T>(fn: T, deps: Deps): T {
	const inst = active()
	const index = hookIndex++
	const slot = inst.hooks[index] as { deps: Deps; value: T } | undefined
	if (!slot || depsChanged(slot.deps, deps)) {
		inst.hooks[index] = { deps, value: fn }
		return fn
	}
	return slot.value
}

export function useRef<T>(initial: T): { current: T } {
	const inst = active()
	const index = hookIndex++
	if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
	return inst.hooks[index] as { current: T }
}

export type FakeContext<T> = {
	defaultValue: T
	value: T
	hasValue: boolean
	Provider: { context: FakeContext<T> }
}

export function createContext<T>(defaultValue: T): FakeContext<T> {
	const ctx = {
		defaultValue,
		value: defaultValue,
		hasValue: false,
	} as FakeContext<T>
	ctx.Provider = { context: ctx }
	return ctx
}

/** Test helper: make `useContext(ctx)` return `value` (or reset with `undefined`). */
export function provideContext<T>(ctx: unknown, value: T | undefined): void {
	const c = ctx as FakeContext<T | undefined>
	c.value = value === undefined ? c.defaultValue : value
	c.hasValue = value !== undefined
}

export function useContext<T>(ctx: FakeContext<T>): T {
	return ctx.value
}

export const use = useContext

export type HookResult<R> = {
	readonly current: R
	readonly renders: number
	rerender: () => void
	unmount: () => void
}

/** Render `hook` once (plus effect-driven re-renders) and keep it mounted. */
export function renderHook<R>(hook: () => R): HookResult<R> {
	let latest: R | undefined
	let renders = 0
	const inst: Instance = {
		hooks: [],
		pendingEffects: [],
		rendering: false,
		dirty: false,
		unmounted: false,
		render: () => {
			if (inst.unmounted) return
			if (inst.rendering) {
				inst.dirty = true
				return
			}
			inst.rendering = true
			try {
				do {
					inst.dirty = false
					const previous = current
					const previousIndex = hookIndex
					current = inst
					hookIndex = 0
					try {
						latest = hook()
						renders += 1
					} finally {
						current = previous
						hookIndex = previousIndex
					}
					const effects = inst.pendingEffects.splice(0)
					for (const effect of effects) {
						const slot = inst.hooks[effect.index] as EffectSlot
						if (typeof slot.cleanup === "function") slot.cleanup()
						slot.cleanup = effect.run()
					}
				} while (inst.dirty && !inst.unmounted)
			} finally {
				inst.rendering = false
			}
		},
	}
	inst.render()
	return {
		get current() {
			return latest as R
		},
		get renders() {
			return renders
		},
		rerender: () => inst.render(),
		unmount: () => {
			inst.unmounted = true
			for (const slot of inst.hooks) {
				const maybe = slot as EffectSlot | undefined
				if (
					maybe &&
					"cleanup" in maybe &&
					typeof maybe.cleanup === "function"
				) {
					maybe.cleanup()
				}
			}
		},
	}
}

/** Let pending promise callbacks (mocked fetches) settle. */
export const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const React = {
	useState,
	useEffect,
	useLayoutEffect,
	useMemo,
	useCallback,
	useRef,
	useContext,
	use,
	createContext,
}

export default React
