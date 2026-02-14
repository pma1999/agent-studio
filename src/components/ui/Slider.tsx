import React from 'react';

interface SliderProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  displayValue?: string;
}

export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.1,
  displayValue,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {label && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <label style={{
            fontSize: '0.8125rem',
            fontWeight: 500,
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-body)',
            letterSpacing: '0.02em',
          }}>
            {label}
          </label>
          <span style={{
            fontSize: '0.8125rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--accent)',
            fontWeight: 500,
          }}>
            {displayValue ?? value}
          </span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          width: '100%',
          height: '4px',
          appearance: 'none',
          background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--bg-hover) ${pct}%, var(--bg-hover) 100%)`,
          borderRadius: '2px',
          outline: 'none',
          cursor: 'pointer',
        }}
      />
      <style>{`
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg-base);
          cursor: pointer;
          box-shadow: 0 0 0 3px rgba(201, 149, 107, 0.2);
          transition: box-shadow 150ms ease;
        }
        input[type="range"]::-webkit-slider-thumb:hover {
          box-shadow: 0 0 0 5px rgba(201, 149, 107, 0.3);
        }
        input[type="range"]::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg-base);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}
