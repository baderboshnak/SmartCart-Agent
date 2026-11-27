'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Direction } from 'radix-ui';
import { AlertCircle, ChevronUp, CloudOff, HelpCircle, Loader2, RotateCcw, Scale, ShoppingBasket, Store, TrendingDown, X } from 'lucide-react';
import { LogoMark } from '@/components/brand/logo-mark';
import { ThemeToggle } from '@/components/brand/theme-toggle';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { AgentActivity } from '@/components/chat/agent-activity';
import { ChatInput } from '@/components/chat/chat-input';
import { MessageBubble } from '@/components/chat/message-bubble';
import { Welcome } from '@/components/chat/welcome';
import { CartTabs } from '@/components/cart/cart-tabs';
import { api, ApiError, streamAgent, type ActivityStep, type CartView, type ClientMessage, type UiCartOperation } from '@/lib/client/api';
import { count, fill, formatIls } from '@/lib/client/format';
import { VoiceSession, voiceSupported, type VoiceState } from '@/lib/client/voice-session';
import { conversationLanguage, type Language } from '@/lib/i18n/language';
import { messages as i18n } from '@/lib/i18n/messages';
import { VoiceBar } from '@/components/chat/voice-bar';

const t = i18n.en;
const FOLLOW_UP_ICONS = [TrendingDown, HelpCircle, Scale];
let localIds = 0;
const localId = (prefix: string) => `${prefix}-${Date.now()}-${++localIds}`;

export function SmartCartApp() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [chat, setChat] = useState<ClientMessage[]>([]);
  const [cart, setCart] = useState<CartView | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const [cartBusy, setCartBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [caption, setCaption] = useState({ user: '', assistant: '' });
  const stepsRef = useRef<ActivityStep[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const voiceRef = useRef<VoiceSession | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const data = await api.getSession().catch(error => {
        if (error instanceof ApiError && error.status === 401) return api.createSession();
        throw error;
      });
      setChat(data.session.messages);
      setCart(data.cart);
      setPhase('ready');
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : t.connectionError);
      setPhase('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // The welcome screen starts at the top; a conversation follows the newest message.
    if (!chat.length && !running) element.scrollTo({ top: 0 });
    else element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [chat, steps, running]);

  const updateSteps = (update: (current: ActivityStep[]) => ActivityStep[]) => {
    stepsRef.current = update(stepsRef.current);
    setSteps(stepsRef.current);
  };

  /** Run the agent for one message. Resolves with the answer text (used by voice to speak it). */
  const runAgent = useCallback(async (text: string, via?: 'voice', language?: Language, voiceId?: string): Promise<string> => {
    if (!text.trim()) return '';
    if (runningRef.current) return t.voiceBusy;
    runningRef.current = true;
    setNotice(null);
    const userId = localId('user');
    setChat(current => [...current, { id: userId, role: 'user', content: text, kind: 'text', ...(via ? { via } : {}), createdAt: new Date().toISOString() }]);
    setRunning(true);
    updateSteps(() => []);
    const controller = new AbortController();
    abortRef.current = controller;
    let finished = false;
    let answer = '';
    try {
      await streamAgent(text, event => {
        switch (event.type) {
          case 'agent.started':
            // Show exactly what the agent acted on (voice requests get digits and %).
            setChat(current => current.map(message => message.id === userId ? { ...message, content: event.userText } : message));
            break;
          case 'tool.started':
            updateSteps(current => [...current, { callId: event.callId, tool: event.tool, label: event.label, status: 'running' }]);
            break;
          case 'tool.progress':
            updateSteps(current => current.map(step => step.callId === event.callId
              ? { ...step, message: event.message, processed: event.processed, total: event.total } : step));
            break;
          case 'tool.completed':
            updateSteps(current => current.map(step => step.callId === event.callId
              ? { ...step, status: event.status, summary: event.summary, durationMs: event.durationMs } : step));
            break;
          case 'cart.updated':
            setCart(event.cart);
            break;
          case 'agent.completed':
            finished = true;
            answer = event.message.content;
            setChat(current => [...current, { ...event.message, role: 'assistant', createdAt: new Date().toISOString(), steps: stepsRef.current }]);
            break;
          case 'agent.failed':
            finished = true;
            answer = event.error.message;
            setChat(current => [...current, { id: localId('error'), role: 'assistant', kind: 'error', content: event.error.message, createdAt: new Date().toISOString(), steps: stepsRef.current }]);
            break;
        }
      }, controller.signal, via, language, voiceId);
      if (!finished) throw new Error('The connection closed before SmartCart finished.');
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : t.connectionError;
        answer = message;
        setChat(current => [...current, { id: localId('error'), role: 'assistant', kind: 'error', content: message, createdAt: new Date().toISOString() }]);
      }
      api.getCart().then(data => setCart(data.cart)).catch(() => {});
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      setRunning(false);
      updateSteps(() => []);
    }
    return answer;
  }, []);

  const send = useCallback((text: string) => { void runAgent(text); }, [runAgent]);
  const stop = () => abortRef.current?.abort();

  const toggleVoice = useCallback(async () => {
    if (voiceRef.current) {
      await voiceRef.current.stop();
      voiceRef.current = null;
      return;
    }
    if (!voiceSupported()) {
      setNotice(t.voiceUnsupported);
      return;
    }
    setNotice(null);
    setCaption({ user: '', assistant: '' });
    const session = new VoiceSession({
      onState: state => {
        setVoiceState(state);
        if (state === 'idle' && voiceRef.current === session) voiceRef.current = null;
      },
      onCaption: setCaption,
      onToolRequest: (request, language, voiceId) => runAgent(request, 'voice', language, voiceId),
      onExchangeComplete: ({ userText, assistantText, usedTool }) => {
        // Exchanges that reached the agent are already in the chat (request and verified answer).
        if (usedTool || (!userText && !assistantText)) return;
        const now = new Date().toISOString();
        setChat(current => [
          ...current,
          ...(userText ? [{ id: localId('voice-user'), role: 'user' as const, content: userText, kind: 'text' as const, via: 'voice' as const, createdAt: now }] : []),
          ...(assistantText ? [{ id: localId('voice-reply'), role: 'assistant' as const, content: assistantText, kind: 'text' as const, createdAt: now }] : [])
        ]);
      },
      onError: message => setNotice(message)
    });
    voiceRef.current = session;
    await session.start();
  }, [runAgent]);

  useEffect(() => () => { void voiceRef.current?.stop(); }, []);

  const editCart = useCallback(async (operation: UiCartOperation) => {
    if (!cart || cartBusy) return;
    setCartBusy(true);
    setNotice(null);
    try {
      const result = await api.editCart(cart.revision, operation);
      setCart(result.cart);
      if (result.recalculationError) setNotice(fill(t.recalculationError, { error: result.recalculationError }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const latest = await api.getCart().catch(() => null);
        if (latest) setCart(latest.cart);
        setNotice(t.conflict);
      } else {
        setNotice(error instanceof ApiError ? error.message : t.connectionError);
      }
    } finally {
      setCartBusy(false);
    }
  }, [cart, cartBusy]);

  const newSession = async () => {
    if (running) return;
    if ((chat.length > 0 || (cart?.items.length ?? 0) > 0) && !window.confirm(t.newChatConfirm)) return;
    try {
      const data = await api.createSession();
      setChat(data.session.messages);
      setCart(data.cart);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : t.connectionError);
    }
  };

  const busy = cartBusy || running;
  const itemCount = cart?.items.length ?? 0;
  // The latest failed answer offers "Try again" with the customer's last message.
  const lastMessage = chat.at(-1);
  const retryText = lastMessage?.kind === 'error' ? [...chat].reverse().find(message => message.role === 'user')?.content ?? null : null;

  return (
    <Direction.Provider dir={t.dir}>
      <div className="flex h-dvh flex-col">
        <header className="z-30 flex h-[4.5rem] shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <LogoMark className="size-11" />
            <div className="min-w-0">
              <p className="font-display text-[1.45rem] leading-none font-semibold tracking-tight">{t.appName}</p>
              <p className="mt-1 hidden truncate text-[0.8rem] text-muted-foreground sm:block">{t.tagline}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="me-1 hidden items-center gap-1.5 rounded-full border border-border/70 bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground md:inline-flex">
              <Store className="size-3.5" />{t.storesBadge}
            </span>
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={newSession} disabled={running || phase !== 'ready'}><RotateCcw />{t.newChat}</Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="scrollbar-thin flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-4xl space-y-7 px-4 py-8 sm:px-8">
                {phase === 'loading' && (
                  <div className="flex flex-col items-center gap-4 py-24 text-sm text-muted-foreground">
                    <LogoMark className="float-soft size-16" />
                    <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{t.loading}</span>
                  </div>
                )}
                {phase === 'error' && (
                  <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 rounded-3xl border border-border/70 bg-card p-8 text-center shadow-soft">
                    <span className="flex size-14 items-center justify-center rounded-full bg-warning-soft text-gold-foreground"><CloudOff className="size-6" /></span>
                    <div className="space-y-1.5">
                      <p className="font-display text-xl font-semibold">{t.connectionErrorTitle}</p>
                      <p className="text-sm leading-relaxed text-muted-foreground">{notice ?? t.connectionError}</p>
                    </div>
                    <Button onClick={() => void load()}><RotateCcw />{t.tryAgain}</Button>
                  </div>
                )}
                {phase === 'ready' && chat.length === 0 && !running && <Welcome onPick={send} onVoice={() => void toggleVoice()} disabled={running} />}
                {chat.map((message, index) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    onOption={send}
                    disabled={running}
                    onRetry={index === chat.length - 1 && retryText ? () => send(retryText) : undefined}
                  />
                ))}
                {running && <AgentActivity steps={steps} />}
              </div>
            </div>

            <div className="shrink-0 bg-linear-to-t from-background via-background/95 to-transparent pt-2">
              <div className="mx-auto w-full max-w-4xl space-y-3 px-4 pb-3 sm:px-8 sm:pb-5">
                {notice && phase === 'ready' && (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-warning/35 bg-warning-soft px-3.5 py-2.5 text-sm animate-in fade-in slide-in-from-bottom-1">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-gold-foreground" /><span className="flex-1">{notice}</span>
                    <button type="button" aria-label={t.dismiss} onClick={() => setNotice(null)} className="rounded-full p-0.5 text-muted-foreground transition hover:bg-black/5 hover:text-foreground"><X className="size-4" /></button>
                  </div>
                )}
                {itemCount > 0 && !running && (
                  <div className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5">
                    {t.followUps.map((text, index) => {
                      const Icon = FOLLOW_UP_ICONS[index] ?? HelpCircle;
                      return (
                        <button
                          key={text}
                          type="button"
                          // The button text is English UI copy; reply in the language the customer has been using.
                          onClick={() => void runAgent(text, undefined, conversationLanguage(chat) ?? undefined)}
                          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border/80 bg-card px-4 py-2 text-sm font-semibold shadow-soft transition hover:-translate-y-px hover:border-primary/30 hover:text-primary"
                        >
                          <Icon className="size-4 text-primary" />{text}
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setSheetOpen(true)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-border/80 bg-card px-3.5 py-2.5 text-start shadow-soft transition hover:border-primary/30 lg:hidden"
                >
                  <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <ShoppingBasket className="size-[1.15rem]" />
                    {itemCount > 0 && (
                      <span className="absolute -end-1.5 -top-1.5 flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.7rem] leading-5 font-bold text-primary-foreground">{itemCount}</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{t.mobileCart}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {itemCount ? (cart?.basket ? `${count(itemCount, t.item, t.items)} · ${cart.basket.storeName}` : count(itemCount, t.item, t.items)) : t.emptyCartTitle}
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums">
                    {cart?.basket ? formatIls(cart.basket.totalPriceIls) : cart?.status === 'NEEDS_CALCULATION' ? <span className="text-xs text-gold-foreground">{t.pricesNeeded}</span> : null}
                  </span>
                  <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
                </button>
                {voiceState !== 'idle' && <VoiceBar state={voiceState} caption={caption} onStop={() => void toggleVoice()} />}
                <ChatInput
                  onSend={send}
                  onStop={stop}
                  running={running}
                  disabled={phase !== 'ready'}
                  voiceActive={voiceState !== 'idle'}
                  onVoice={() => void toggleVoice()}
                />
                <p className="hidden text-center text-xs text-muted-foreground sm:block">{t.inputHint}</p>
              </div>
            </div>
          </main>

          <aside className="hidden w-[27rem] shrink-0 flex-col border-s border-border/60 bg-card/55 backdrop-blur-xl lg:flex xl:w-[31rem]" aria-label={t.cartTitle}>
            <CartTabs cart={cart} busy={busy} onEdit={editCart} />
          </aside>
        </div>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent className="lg:hidden">
            <SheetTitle className="sr-only">{t.cartTitle}</SheetTitle>
            <SheetDescription className="sr-only">{t.storesIntro}</SheetDescription>
            <div className="flex min-h-0 flex-1 flex-col"><CartTabs cart={cart} busy={busy} onEdit={editCart} /></div>
          </SheetContent>
        </Sheet>
      </div>
    </Direction.Provider>
  );
}
