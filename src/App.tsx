import { useState } from 'react';
import { ImageGenerator } from './components/ImageGenerator';
import { GenerationTypeSelector } from './components/GenerationTypeSelector';

export default function App() {
  const [generationType, setGenerationType] = useState<'sketch-to-image' | 'text-to-image' | 'image-to-video'>('sketch-to-image');

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">AI Image Generator</h1>
      <GenerationTypeSelector value={generationType} onChange={setGenerationType} />
      <ImageGenerator generationType={generationType} />
    </div>
  );
} 