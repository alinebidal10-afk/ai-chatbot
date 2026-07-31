"use client";

import { MODELS } from "@/lib/models";

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export default function ModelPicker({
  value,
  onChange,
  disabled,
}: ModelPickerProps) {
  return (
    <label className="flex items-center gap-1 text-xs text-ink/70">
      <span className="sr-only">Model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title="Model used for the next message"
        className="touch-target rounded-full bg-transparent px-1.5 py-1.5 text-xs text-ink/80 hover:bg-cat-highlight/50 focus:outline-none focus:ring-2 focus:ring-cat-outline/50 disabled:opacity-50"
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
