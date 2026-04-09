"use client";

import { useState } from "react";
import { ClipboardCopy, Pencil, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ResponseEditorProps {
  response: string;
  onMarkResponded?: () => void;
  isResponded?: boolean;
}

export default function ResponseEditor({
  response,
  onMarkResponded,
  isResponded,
}: ResponseEditorProps) {
  const [editMode, setEditMode] = useState(false);
  const [editedResponse, setEditedResponse] = useState(response);
  const [copied, setCopied] = useState(false);

  const copyResponse = () => {
    const text = editMode ? editedResponse : response;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      {editMode ? (
        <Textarea
          value={editedResponse}
          onChange={(e) => setEditedResponse(e.target.value)}
          rows={10}
          className="font-mono text-sm"
          autoFocus
        />
      ) : (
        <div className="whitespace-pre-wrap rounded-md bg-slate-50 p-4 text-sm text-slate-700">
          {response}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <Button onClick={copyResponse} variant="outline" size="sm">
          <ClipboardCopy size={14} className="mr-1" />
          {copied ? "Copied!" : "Copy Response"}
        </Button>
        <Button
          onClick={() => setEditMode(!editMode)}
          variant="outline"
          size="sm"
        >
          <Pencil size={14} className="mr-1" />
          {editMode ? "Preview" : "Edit"}
        </Button>
        {onMarkResponded && !isResponded && (
          <Button
            onClick={onMarkResponded}
            size="sm"
            className="bg-green-600 hover:bg-green-700"
          >
            <Check size={14} className="mr-1" />
            Mark Responded
          </Button>
        )}
        {isResponded && (
          <span className="text-xs text-green-600 font-medium">
            Marked as responded
          </span>
        )}
      </div>
    </div>
  );
}
