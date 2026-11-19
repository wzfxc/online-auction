'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Link, useRouter } from '@/i18n/navigation';
import { unwrap } from '@/lib/api';
import { useApp } from '@/lib/providers';

const loginFormSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});
type LoginForm = z.infer<typeof loginFormSchema>;

const DEMO_USERS = [
  { label: 'buyer1 (50 000 ₴)', email: 'buyer1@auction.test' },
  { label: 'buyer2 (50 000 ₴)', email: 'buyer2@auction.test' },
  { label: 'seller1', email: 'seller1@auction.test' },
  { label: 'moderator1', email: 'moderator1@auction.test' },
  { label: 'finance1', email: 'finance1@auction.test' },
];

export default function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const { client, setSession } = useApp();
  const [serverError, setServerError] = useState<unknown>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const auth = unwrap(await client.POST('/auth/login', { body: values }));
      setSession(auth);
      router.push('/');
    } catch (e) {
      setServerError(e);
    }
  });

  return (
    <div className="mx-auto max-w-md space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-bold text-slate-900">{t('loginTitle')}</h1>
      <ErrorBanner error={serverError} />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-slate-700">
            {t('emailLabel')}
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'login-email-err' : undefined}
            {...register('email')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {errors.email && (
            <p id="login-email-err" className="mt-1 text-xs text-rose-600">
              {errors.email.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-slate-700">
            {t('passwordLabel')}
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? 'login-password-err' : undefined}
            {...register('password')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {errors.password && (
            <p id="login-password-err" className="mt-1 text-xs text-rose-600">
              {errors.password.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          data-testid="login-submit"
          className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {t('loginButton')}
        </button>
      </form>

      <div className="border-t border-slate-200 pt-4 text-xs text-slate-600">
        <p className="mb-2 font-medium">{t('demoAccounts')}</p>
        <div className="flex flex-wrap gap-1.5">
          {DEMO_USERS.map((d) => (
            <button
              key={d.email}
              type="button"
              onClick={() => {
                setValue('email', d.email);
                setValue('password', 'password123');
              }}
              className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-center text-sm text-slate-600">
        {t('noAccount')}{' '}
        <Link href="/register" className="font-semibold text-brand-700 hover:underline">
          {t('registerButton')}
        </Link>
      </p>
    </div>
  );
}
