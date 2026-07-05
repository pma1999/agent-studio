import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../stores/store';
import { authApi, setAuthToken } from '../api/client';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

export function AuthView() {
  const { setUser } = useStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    if (mode === 'register' && password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        const res = await authApi.login(email.trim(), password);
        setAuthToken(res.token);
        setUser(res.user);
      } else {
        const res = await authApi.register(email.trim(), password);
        setAuthToken(res.token);
        setUser(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-lg)',
        position: 'relative',
        overflow: 'hidden',
        background:
          'radial-gradient(110% 70% at 50% -10%, var(--accent-ghost) 0%, transparent 55%), var(--surface-0)',
      }}
    >
      {/* Atmospheric vignette (edges only) */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(80% 60% at 50% 50%, transparent 40%, rgb(var(--black-rgb) / 0.45) 100%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{ width: '100%', maxWidth: 400, position: 'relative' }}
      >
        {/* Brand poster */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginBottom: 'var(--space-xl)' }}>
          <div style={{
            width: 52,
            height: 52,
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-accent)',
          }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.7rem', fontWeight: 700, color: 'var(--text-on-accent)' }}>A</span>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--text-accent)',
              marginBottom: 6,
            }}>
              Personal AI workspace
            </div>
            <h1 style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(2rem, 8vw, 2.5rem)',
              fontWeight: 600,
              color: 'var(--text-primary)',
              lineHeight: 1.05,
              letterSpacing: '-0.01em',
            }}>
              Agent Studio
            </h1>
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-xl)',
          boxShadow: 'var(--shadow-xl)',
        }}>
          <p style={{
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
            textAlign: 'center',
            marginTop: 0,
            marginBottom: 'var(--space-lg)',
          }}>
            {mode === 'login' ? 'Sign in to sync your agents and conversations' : 'Create an account to sync across devices'}
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            <Input
              type="email"
              label="Email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={loading}
            />
            <Input
              type="password"
              label="Password"
              placeholder={mode === 'register' ? 'Min. 6 characters' : '••••••••'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={loading}
            />
            {error && (
              <p style={{ fontSize: '0.8125rem', color: 'var(--error)', margin: 0 }}>
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" loading={loading} style={{ marginTop: 8, width: '100%' }}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: 'var(--space-md)', marginBottom: 0 }}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                padding: 0,
                font: 'inherit',
                textDecoration: 'underline',
              }}
            >
              {mode === 'login' ? 'Register' : 'Sign in'}
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
