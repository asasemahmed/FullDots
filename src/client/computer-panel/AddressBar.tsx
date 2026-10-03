import { useState } from 'react';
import { ArrowRight, Globe } from 'lucide-react';
import { normalizeUrl } from './model';

/** A quiet field for sending the browser somewhere. Enter goes. */
export function AddressBar({
  disabled,
  placeholder,
  onOpen,
}: {
  disabled: boolean;
  placeholder: string;
  /** Resolves true once the page was opened, so the field can be cleared. */
  onOpen: (url: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="cp-address"
      onSubmit={(event) => {
        event.preventDefault();
        const url = normalizeUrl(value);
        try {
          const parsed = new URL(url);
          if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
        } catch {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        void onOpen(url).then((opened) => {
          if (opened) setValue('');
        });
      }}
    >
      <Globe size={14} aria-hidden="true" />
      <input
        type="text"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Open a web address"
        aria-invalid={invalid}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
      />
      <button
        type="submit"
        className="cp-icon-btn"
        aria-label="Open page"
        disabled={disabled || !value.trim()}
      >
        <ArrowRight size={15} aria-hidden="true" />
      </button>
      {invalid && (
        <span className="cp-address-error" role="alert">
          Enter a web address like example.com
        </span>
      )}
    </form>
  );
}
