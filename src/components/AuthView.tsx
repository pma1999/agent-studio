import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../stores/store';
import { authApi } from '../api/client';
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
        setUser(res.user);
      } else {
        const res = await authApi.register(email.trim(), password);
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
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base)',
        padding: 'var(--space-lg)',
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-xl)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--heading-2-size)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: 4,
            textAlign: 'center',
          }}
        >
          Agent Studio
        </h1>
        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
            textAlign: 'center',
            marginBottom: 'var(--space-lg)',
          }}
        >
          Sign in to sync your agents and conversations
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
          <Button type="submit" variant="primary" loading={loading} style={{ marginTop: 8 }}>
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
      </motion.div>
    </div>
  );
}
