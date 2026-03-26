import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

type ChatInputProps = {
  disabled: boolean;
  isFocused: boolean;
  isStreaming: boolean;
  placeholder?: string;
  onSubmit: (value: string) => Promise<void> | void;
};

export const ChatInput = ({ disabled, isFocused, isStreaming, placeholder, onSubmit }: ChatInputProps) => {
  const [draft, setDraft] = useState("");
  const [inputKey, setInputKey] = useState(0);

  useEffect(() => {
    if (disabled) {
      setDraft("");
      setInputKey((value) => value + 1);
    }
  }, [disabled]);

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }

    setDraft("");
    setInputKey((current) => current + 1);
    await onSubmit(trimmed);
  };

  return (
    <Box
      borderStyle="single"
      borderColor={isFocused ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      <Text color="gray">{isStreaming ? "Streaming - press Esc to cancel" : "Press Enter to send"}</Text>
      <TextInput
        key={inputKey}
        defaultValue={draft}
        isDisabled={disabled}
        placeholder={placeholder ?? (disabled ? "Select a running ghost to chat" : "Talk to ghost...")}
        onChange={setDraft}
        onSubmit={handleSubmit}
      />
    </Box>
  );
};
