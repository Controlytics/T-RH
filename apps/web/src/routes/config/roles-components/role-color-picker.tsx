export const PRESET_COLORS = [
  { value: 'bg-gradient-to-r from-red-500 to-pink-500', label: 'Red-Pink' },
  { value: 'bg-gradient-to-r from-purple-500 to-indigo-500', label: 'Purple-Indigo' },
  { value: 'bg-gradient-to-r from-blue-500 to-cyan-500', label: 'Blue-Cyan' },
  { value: 'bg-gradient-to-r from-emerald-500 to-green-500', label: 'Emerald-Green' },
  { value: 'bg-gradient-to-r from-amber-500 to-orange-500', label: 'Amber-Orange' },
  { value: 'bg-gradient-to-r from-slate-400 to-slate-500', label: 'Slate' },
  { value: 'bg-gradient-to-r from-teal-500 to-cyan-500', label: 'Teal-Cyan' },
  { value: 'bg-gradient-to-r from-rose-500 to-red-500', label: 'Rose-Red' },
];

interface RoleColorPickerProps {
  selectedColor: string;
  onSelect: (color: string) => void;
}

export function RoleColorPicker({ selectedColor, onSelect }: RoleColorPickerProps) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {PRESET_COLORS.map((color) => (
        <button
          key={color.value}
          onClick={() => onSelect(color.value)}
          className={`h-10 rounded-lg ${color.value} transition-all ${
            selectedColor === color.value ? 'ring-2 ring-offset-2 ring-purple-500' : ''
          }`}
          title={color.label}
        />
      ))}
    </div>
  );
}
