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

const registerFormSchema = z.object({
  email: z.string().trim().email(),
  displayName: z.string().trim().min(2).max(60),
  password: z.string().min(8).max(128),
  role: z.enum(['buyer', 'seller']),
});
type RegisterForm = z.infer<typeof registerFormSchema>;

export default function RegisterPage() {
  const t = useTranslations('auth');
  const tRoles = useTranslations('roles');
  const router = useRouter();
  const { client, setSession } = useApp();
  const [serverError, setServerError] = useState<unknown>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: '', displayName: '', password: '', role: 'buyer' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const auth = unwrap(await client.POST('/auth/register', { body: values }));
      setSession(auth);
      router.push('/');
    } catch (e) {
      setServerError(e);
    }
  });

  return (
    <div className="mx-auto max-w-md space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-bold text-slate-900">{t('registerTitle')}</h1>
      <ErrorBanner error={serverError} />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="reg-email" className="mb-1 block text-sm font-medium text-slate-700">
            {t('emailLabel')}
          </label>
          <input
            id="reg-email"
            type="email"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'reg-email-err' : undefined}
            {...register('email')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {errors.email && (
            <p id="reg-email-err" className="mt-1 text-xs text-rose-600">
              {errors.email.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="reg-name" className="mb-1 block text-sm font-medium text-slate-700">
            {t('displayNameLabel')}
          </label>
          <input
            id="reg-name"
            type="text"
            aria-invalid={Boolean(errors.displayName)}
            aria-describedby={errors.displayName ? 'reg-name-err' : undefined}
            {...register('displayName')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {errors.displayName && (
            <p id="reg-name-err" className="mt-1 text-xs text-rose-600">
              {errors.displayName.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="reg-password" className="mb-1 block text-sm font-medium text-slate-700">
            {t('passwordLabel')}
          </label>
          <input
            id="reg-password"
            type="password"
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? 'reg-password-err' : undefined}
            {...register('password')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {errors.password && (
            <p id="reg-password-err" className="mt-1 text-xs text-rose-600">
              {errors.password.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="reg-role" className="mb-1 block text-sm font-medium text-slate-700">
            {t('roleLabel')}
          </label>
          <select id="reg-role" {...register('role')} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="buyer">{tRoles('buyer')}</option>
            <option value="seller">{tRoles('seller')}</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          data-testid="register-submit"
          className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {t('registerButton')}
        </button>
      </form>

      <p className="text-center text-sm text-slate-600">
        {t('hasAccount')}{' '}
        <Link href="/login" className="font-semibold text-brand-700 hover:underline">
          {t('loginButton')}
        </Link>
      </p>
    </div>
  );
}
