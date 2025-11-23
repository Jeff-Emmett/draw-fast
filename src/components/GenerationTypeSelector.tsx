interface GenerationTypeSelectorProps {
  value: 'sketch-to-image' | 'text-to-image' | 'image-to-video';
  onChange: (type: 'sketch-to-image' | 'text-to-image' | 'image-to-video') => void;
}

export function GenerationTypeSelector({ value, onChange }: GenerationTypeSelectorProps) {
  return (
    <div className="flex gap-2 mb-4">
      <button
        className={`px-4 py-2 rounded ${
          value === 'sketch-to-image' ? 'bg-blue-500 text-white' : 'bg-gray-200'
        }`}
        onClick={() => onChange('sketch-to-image')}
      >
        Sketch to Image
      </button>
      <button
        className={`px-4 py-2 rounded ${
          value === 'text-to-image' ? 'bg-blue-500 text-white' : 'bg-gray-200'
        }`}
        onClick={() => onChange('text-to-image')}
      >
        Text to Image
      </button>
      <button
        className={`px-4 py-2 rounded ${
          value === 'image-to-video' ? 'bg-blue-500 text-white' : 'bg-gray-200'
        }`}
        onClick={() => onChange('image-to-video')}
      >
        Image to Video
      </button>
    </div>
  );
} 