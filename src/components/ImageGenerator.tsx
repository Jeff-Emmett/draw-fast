import { fal } from "@fal-ai/client";
import { useState } from "react";

interface ImageGeneratorProps {
  generationType: 'sketch-to-image' | 'text-to-image' | 'image-to-video';
}

export function ImageGenerator({ generationType, ...props }: ImageGeneratorProps) {
  const [prompt, setPrompt] = useState('');
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  const generateOutput = async () => {
    setIsLoading(true);
    try {
      let result;
      
      switch (generationType) {
        case 'text-to-image':
          result = await fal.subscribe("fal-ai/flux/dev", {
            input: {
              prompt: prompt,
            },
          });
          break;

        case 'image-to-video':
          if (!inputImage) {
            throw new Error('Input image is required for image-to-video');
          }
          result = await fal.subscribe("fal-ai/minimax-video/image-to-video", {
            input: {
              prompt: prompt,
              image_url: inputImage
            },
          });
          break;

        case 'sketch-to-image':
          // ... existing sketch-to-image logic ...
          break;
      }

      setResult(result);
    } catch (error) {
      console.error('Generation failed:', error);
      setError('Failed to generate output');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Input Section */}
      <div className="flex flex-col gap-2">
        <textarea
          className="w-full p-2 border rounded"
          placeholder="Enter your prompt..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {(generationType === 'sketch-to-image' || generationType === 'image-to-video') && (
          <div className="border-2 border-dashed p-4 text-center">
            {/* Existing image upload/sketch component */}
          </div>
        )}

        <button
          className="bg-blue-500 text-white px-4 py-2 rounded"
          onClick={generateOutput}
          disabled={isLoading}
        >
          {isLoading ? 'Generating...' : `Generate ${generationType.replace(/-/g, ' ')}`}
        </button>
      </div>

      {/* Result Section */}
      {error && <div className="text-red-500">{error}</div>}
      {result && (
        <div className="border rounded p-4">
          {generationType === 'image-to-video' ? (
            <video controls className="w-full">
              <source src={result.url} type="video/mp4" />
            </video>
          ) : (
            <img src={result.url} alt="Generated output" className="w-full" />
          )}
        </div>
      )}
    </div>
  );
} 