import loginLogo from '@renderer/assets/logos/brand/app.png';
import { Alert, Button, Form, Input, Link } from '@arco-design/web-react';
import { ArrowLeft } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth, type ChangePasswordErrorCode } from '@renderer/hooks/context/AuthContext';
import './LoginPage.css';

interface ChangePasswordFormValues {
  username: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

type PageMessage = { type: 'success' | 'error'; text: string };

const ChangePasswordPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { status, changePassword } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [form] = Form.useForm<ChangePasswordFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<PageMessage | null>(null);
  const routeUsername = useMemo(() => {
    const value = (location.state as { username?: unknown } | null)?.username;
    return typeof value === 'string' ? value.trim() : '';
  }, [location.state]);

  useEffect(() => {
    document.body.classList.add('login-page-active');
    document.title = t('login.changePassword.pageTitle');
    document.documentElement.lang = i18n.language;
    form.setFieldValue('username', routeUsername);
    return () => document.body.classList.remove('login-page-active');
  }, [form, i18n.language, routeUsername, t]);

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate('/guid', { replace: true });
    }
  }, [navigate, status]);

  const errorText = (code?: ChangePasswordErrorCode, fallback?: string): string => {
    switch (code) {
      case 'requiredFields':
        return t('login.changePassword.errors.required');
      case 'passwordMismatch':
        return t('login.changePassword.errors.mismatch');
      case 'invalidCurrentPassword':
        return t('login.changePassword.errors.invalidCurrentPassword');
      case 'passwordPolicy':
        return t('login.changePassword.errors.passwordPolicy');
      case 'passwordReused':
        return t('login.changePassword.errors.passwordReused');
      case 'tooManyAttempts':
        return t('login.changePassword.errors.tooManyAttempts');
      case 'networkError':
        return t('login.changePassword.errors.networkError');
      case 'serverError':
        return t('login.changePassword.errors.serverError');
      case 'securityError':
        return t('login.changePassword.errors.securityError');
      case 'unknown':
      default:
        return fallback ?? t('login.changePassword.errors.unknown');
    }
  };

  const handleSubmit = async (values: ChangePasswordFormValues) => {
    setSubmitting(true);
    setMessage(null);
    const username = values.username.trim();
    const result = await changePassword({
      username,
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
      confirmPassword: values.confirmPassword,
    });
    setSubmitting(false);

    if (result.success) {
      setMessage({ type: 'success', text: t('login.changePassword.success') });
      form.setFieldsValue({ currentPassword: '', newPassword: '', confirmPassword: '' });
      localStorage.removeItem('rememberMe');
      localStorage.removeItem('rememberedUsername');
      localStorage.removeItem('rememberedPassword');
      window.setTimeout((): void => {
        void navigate('/login', { replace: true, state: { username } });
      }, 900);
      return;
    }

    setMessage({ type: 'error', text: errorText(result.code, result.message) });
  };

  if (status === 'checking') {
    return <AppLoader />;
  }

  return (
    <div className='login-page'>
      <div className='login-page__card login-page__card--change-password'>
        <div className='login-page__header'>
          <div className='login-page__logo'>
            <img src={loginLogo} alt={t('login.brand')} />
          </div>
          <h1 className='login-page__title'>{t('login.changePassword.title')}</h1>
          <p className='login-page__subtitle'>{t('login.changePassword.subtitle')}</p>
        </div>

        {message && (
          <Alert
            className='login-page__change-alert'
            type={message.type}
            content={message.text}
            showIcon
            closable={message.type === 'error'}
            onClose={() => setMessage(null)}
          />
        )}

        <Form<ChangePasswordFormValues>
          form={form}
          layout='vertical'
          className='login-page__change-form'
          autoComplete='off'
          onSubmit={handleSubmit}
        >
          <Form.Item
            label={t('login.username')}
            field='username'
            rules={[{ required: true, message: t('login.changePassword.errors.required') }]}
          >
            <Input placeholder={t('login.usernamePlaceholder')} autoComplete='username' allowClear />
          </Form.Item>
          <Form.Item
            label={t('login.changePassword.currentPassword')}
            field='currentPassword'
            rules={[{ required: true, message: t('login.changePassword.errors.required') }]}
          >
            <Input.Password
              placeholder={t('login.changePassword.currentPasswordPlaceholder')}
              autoComplete='current-password'
            />
          </Form.Item>
          <Form.Item
            label={t('login.changePassword.newPassword')}
            field='newPassword'
            rules={[
              { required: true, message: t('login.changePassword.errors.required') },
              { minLength: 12, message: t('login.changePassword.errors.passwordPolicy') },
            ]}
          >
            <Input.Password
              placeholder={t('login.changePassword.newPasswordPlaceholder')}
              autoComplete='new-password'
            />
          </Form.Item>
          <Form.Item
            label={t('login.changePassword.confirmPassword')}
            field='confirmPassword'
            rules={[
              { required: true, message: t('login.changePassword.errors.required') },
              {
                validator: (value, callback) => {
                  if (value !== form.getFieldValue('newPassword')) {
                    callback(t('login.changePassword.errors.mismatch'));
                    return;
                  }
                  callback();
                },
              },
            ]}
          >
            <Input.Password
              placeholder={t('login.changePassword.confirmPasswordPlaceholder')}
              autoComplete='new-password'
            />
          </Form.Item>
          <p className='login-page__password-requirement'>{t('login.changePassword.requirement')}</p>
          <Button className='login-page__change-submit' type='primary' htmlType='submit' loading={submitting} long>
            {t('login.changePassword.submit')}
          </Button>
        </Form>

        <div className='login-page__back-link-row'>
          <Link
            className='login-page__back-link'
            icon={<ArrowLeft theme='outline' size='16' />}
            onClick={() => void navigate('/login', { state: { username: form.getFieldValue('username') } })}
          >
            {t('login.changePassword.backToLogin')}
          </Link>
        </div>
      </div>
    </div>
  );
};

export default ChangePasswordPage;
