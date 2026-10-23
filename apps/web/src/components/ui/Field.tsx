import {
	useId,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
} from "react"

interface FieldShellProps {
	id: string
	label: string
	hint?: ReactNode
	children: ReactNode
}

function FieldShell({ id, label, hint, children }: FieldShellProps) {
	return (
		<div className="field">
			<label className="field__label" htmlFor={id}>
				{label}
			</label>
			{children}
			{hint ? <p className="field__hint">{hint}</p> : null}
		</div>
	)
}

export interface TextFieldProps extends Omit<
	InputHTMLAttributes<HTMLInputElement>,
	"id"
> {
	id?: string
	label: string
	hint?: ReactNode
}

export function TextField({
	id,
	label,
	hint,
	className,
	...input
}: TextFieldProps) {
	const generatedId = useId()
	const fieldId = id ?? generatedId

	return (
		<FieldShell id={fieldId} label={label} hint={hint}>
			<input
				id={fieldId}
				className={["field__control", className].filter(Boolean).join(" ")}
				{...input}
			/>
		</FieldShell>
	)
}

export interface SelectOption {
	value: string
	label: string
}

export interface SelectFieldProps extends Omit<
	SelectHTMLAttributes<HTMLSelectElement>,
	"id"
> {
	id?: string
	label: string
	hint?: ReactNode
	options: SelectOption[]
}

export function SelectField({
	id,
	label,
	hint,
	options,
	className,
	...select
}: SelectFieldProps) {
	const generatedId = useId()
	const fieldId = id ?? generatedId

	return (
		<FieldShell id={fieldId} label={label} hint={hint}>
			<select
				id={fieldId}
				className={["field__control", className].filter(Boolean).join(" ")}
				{...select}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</FieldShell>
	)
}

export interface StaticFieldProps {
	label: string
	value: ReactNode
	hint?: ReactNode
}

export function StaticField({ label, value, hint }: StaticFieldProps) {
	return (
		<div className="field">
			<span className="field__label">{label}</span>
			<p className="field__static">{value}</p>
			{hint ? <p className="field__hint">{hint}</p> : null}
		</div>
	)
}
