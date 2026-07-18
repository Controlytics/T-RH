import { useState, useEffect } from 'react';

function OptionButtons({ options, value, onChange, colorFn }: {
  options: string[];
  value: string;
  onChange: (val: string) => void;
  colorFn?: (opt: string, selected: boolean) => string;
}) {
  const defaultColor = (opt: string, selected: boolean) =>
    selected ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200';
  const getColor = colorFn ?? defaultColor;
  // a11y (WCAG 1.4.1): selection must not be conveyed by color alone. The
  // selected option carries a checkmark + bold weight + an inset ring, and
  // aria-pressed so assistive tech announces the state.
  return (
    <div className="flex gap-2" role="group">
      {options.map(opt => {
        const selected = value === opt;
        return (
          <button key={opt} type="button" onClick={() => onChange(opt)}
            aria-pressed={selected}
            className={`flex-1 py-2 rounded-lg text-sm transition-colors inline-flex items-center justify-center gap-1.5 ${selected ? 'font-bold ring-2 ring-inset ring-white/70' : 'font-medium'} ${getColor(opt, selected)}`}>
            {selected && (
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {opt}
          </button>
        );
      })}
    </div>
  );
}

interface ChecklistQuestion {
  id: string;
  question: string;
  questionType: string;
  required: boolean;
  section: string | null;
  description: string | null;
  options: any[];
  sortOrder: number;
}

interface PendingChecklist {
  pipelineNodeId: string;
  checklistProfileId: string;
  checklistProfileName: string;
  questions: ChecklistQuestion[];
}

interface ChecklistDialogProps {
  dialog: {
    filterId: string;
    filterName: string;
    checklists: PendingChecklist[];
  } | null;
  onClose: () => void;
  onSubmit: (answers: Record<string, any>) => void;
  loading: boolean;
  error: string;
}

export function ChecklistDialog({ dialog, onClose, onSubmit, loading, error }: ChecklistDialogProps) {
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [internalError, setInternalError] = useState('');

  // Reset internal state when dialog opens/closes
  useEffect(() => {
    if (dialog) {
      setAnswers({});
      setInternalError('');
    }
  }, [dialog]);

  // Close on Escape — but NOT once answers are entered. This checklist is a
  // mandatory, non-dismissible gate (no backdrop dismiss, no skip); a stray
  // Escape must not silently discard a half-filled compliance form. Escape only
  // closes an untouched dialog; once anything is answered the operator must use
  // the explicit Cancel button (a deliberate act).
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (Object.keys(answers).length > 0) return;
      onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, answers]);

  if (!dialog) return null;

  const displayError = error || internalError;

  const handleSubmit = () => {
    // A pending checklist that resolved to ZERO questions means the questions
    // failed to load (a stale/degraded cache — the pipeline never gates on a
    // genuinely question-less checklist). Submitting would post an empty answer
    // set; the server rejects a real required checklist, dead-ending the
    // operator with no explanation. Block it and point to recovery instead.
    if (dialog.checklists.some((cl) => !Array.isArray(cl.questions) || cl.questions.length === 0)) {
      setInternalError('This checklist could not load its questions. Reconnect and refresh, then reopen it before submitting.');
      return;
    }
    // Validate required questions
    for (const cl of dialog.checklists) {
      for (const q of (cl.questions ?? [])) {
        if (q.required && (answers[q.id] === undefined || answers[q.id] === '')) {
          setInternalError(`Please answer: "${q.question}"`);
          return;
        }
      }
    }
    setInternalError('');
    onSubmit(answers);
  };

  const renderQuestionInput = (q: ChecklistQuestion) => {
    const value = answers[q.id] ?? '';
    const onChange = (val: any) => setAnswers(prev => ({ ...prev, [q.id]: val }));

    switch (q.questionType) {
      case 'YES_NO':
        return <OptionButtons options={['Yes', 'No']} value={value} onChange={onChange} />;
      case 'YES_NO_NA':
        return <OptionButtons options={['Yes', 'No', 'N/A']} value={value} onChange={onChange} />;
      case 'PASS_FAIL':
        return <OptionButtons options={['Pass', 'Fail']} value={value} onChange={onChange} colorFn={(opt, sel) => sel ? (opt === 'Pass' ? 'bg-green-600 text-white' : 'bg-red-600 text-white') : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} />;
      case 'NUMERIC':
        return (
          <input type="number" value={value} onChange={e => onChange(e.target.value)}
            className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-500 outline-none" placeholder="Enter value" />
        );
      case 'DROPDOWN':
        return (
          <select value={value} onChange={e => onChange(e.target.value)}
            className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-500 outline-none">
            <option value="">Select...</option>
            {(Array.isArray(q.options) ? q.options : []).map((opt: any, i: number) => (
              <option key={i} value={typeof opt === 'string' ? opt : opt.value}>{typeof opt === 'string' ? opt : opt.label}</option>
            ))}
          </select>
        );
      case 'MULTI_SELECT':
        return (
          <div className="flex flex-wrap gap-2">
            {(Array.isArray(q.options) ? q.options : []).map((opt: any, i: number) => {
              const optVal = typeof opt === 'string' ? opt : opt.value;
              const optLabel = typeof opt === 'string' ? opt : opt.label;
              const selected = Array.isArray(value) && value.includes(optVal);
              return (
                <button key={i} onClick={() => {
                  const arr = Array.isArray(value) ? [...value] : [];
                  if (selected) onChange(arr.filter((v: string) => v !== optVal));
                  else onChange([...arr, optVal]);
                }}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${selected ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {optLabel}
                </button>
              );
            })}
          </div>
        );
      case 'TEXT':
      default:
        return (
          <textarea value={value} onChange={e => onChange(e.target.value)} rows={2}
            className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 text-sm focus:border-cyan-500 outline-none" placeholder="Enter answer" />
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <div className="bg-gradient-to-r from-purple-600 to-purple-700 px-6 py-4 flex items-center gap-3 shrink-0">
          <svg className="w-7 h-7 text-purple-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          <div>
            <h2 className="text-lg font-bold text-white">Checklist Required</h2>
            <p className="text-purple-100 text-sm">{dialog.filterName}</p>
          </div>
        </div>
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {dialog.checklists.map((cl) => (
            <div key={cl.pipelineNodeId}>
              <h3 className="text-sm font-semibold text-purple-700 uppercase tracking-wider mb-3">{cl.checklistProfileName}</h3>
              <div className="space-y-4">
                {(!Array.isArray(cl.questions) || cl.questions.length === 0) && (
                  <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                    Couldn't load this checklist's questions. Reconnect and refresh, then reopen this checklist before submitting.
                  </div>
                )}
                {(cl.questions ?? []).map((q, qi, arr) => {
                  const prevSection = qi > 0 ? arr[qi - 1].section : null;
                  const showSection = q.section && q.section !== prevSection;
                  return (
                    <div key={q.id}>
                      {showSection && (
                        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-2 mb-1 border-b border-slate-200 pb-1">{q.section}</div>
                      )}
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <span className="text-slate-400 text-xs font-mono mt-0.5 w-5 shrink-0">{qi + 1}.</span>
                          <div className="flex-1">
                            <p className="text-sm text-slate-700">
                              {q.question}
                              {q.required && <span className="text-red-600 ml-1">*</span>}
                            </p>
                            {q.description && <p className="text-xs text-slate-400 mt-0.5">{q.description}</p>}
                          </div>
                        </div>
                        <div className="ml-7">
                          {renderQuestionInput(q)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {displayError && <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{displayError}</div>}
        </div>
        <div className="px-6 py-4 border-t border-slate-200 shrink-0 flex gap-3">
          <button onClick={onClose} disabled={loading}
            className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-medium hover:bg-slate-200 transition-colors disabled:opacity-40">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={loading}
            className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-purple-500 transition-colors">
            {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> :
              <><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>Submit Checklist</>}
          </button>
        </div>
      </div>
    </div>
  );
}
