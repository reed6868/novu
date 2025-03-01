import { Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationRepository, IntegrationEntity } from '@novu/dal';
import { ChannelTypeEnum } from '@novu/shared';
import * as Sentry from '@sentry/node';
import { IEmailOptions } from '@novu/stateless';

import { SendTestEmailCommand } from './send-test-email.command';

import { MailFactory } from '../../services/mail-service/mail.factory';
import {
  GetDecryptedIntegrations,
  GetDecryptedIntegrationsCommand,
} from '../../../integrations/usecases/get-decrypted-integrations';
import { ApiException } from '../../../shared/exceptions/api.exception';
import { CompileEmailTemplate } from '../../../content-templates/usecases/compile-email-template/compile-email-template.usecase';
import { CompileEmailTemplateCommand } from '../../../content-templates/usecases/compile-email-template/compile-email-template.command';

@Injectable()
export class SendTestEmail {
  constructor(
    private compileEmailTemplateUsecase: CompileEmailTemplate,
    private organizationRepository: OrganizationRepository,
    private getDecryptedIntegrationsUsecase: GetDecryptedIntegrations
  ) {}

  public async execute(command: SendTestEmailCommand) {
    const mailFactory = new MailFactory();
    const organization = await this.organizationRepository.findById(command.organizationId);
    if (!organization) throw new NotFoundException('Organization not found');

    const email = command.to;

    Sentry.addBreadcrumb({
      message: 'Sending Email',
    });

    const integration = (
      await this.getDecryptedIntegrationsUsecase.execute(
        GetDecryptedIntegrationsCommand.create({
          organizationId: command.organizationId,
          environmentId: command.environmentId,
          channelType: ChannelTypeEnum.EMAIL,
          findOne: true,
          active: true,
          userId: command.userId,
        })
      )
    )[0];

    if (!integration) {
      throw new ApiException(`Missing an active email integration`);
    }

    const { html, subject } = await this.compileEmailTemplateUsecase.execute(
      CompileEmailTemplateCommand.create({
        ...command,
        payload: {
          ...command.payload,
          step: {
            digest: true,
            events: [],
            total_count: 1,
            ...this.getSystemVariables('step', command),
          },
          subscriber: this.getSystemVariables('subscriber', command),
        },
      })
    );

    const mailData: IEmailOptions = {
      to: Array.isArray(email) ? email : [email],
      subject,
      html: html as string,
      from: command.payload.$sender_email || integration?.credentials.from || 'no-reply@novu.co',
    };

    if (email && integration) {
      await this.sendMessage(integration, mailData, mailFactory);

      return;
    }
  }

  private async sendMessage(integration: IntegrationEntity, mailData: IEmailOptions, mailFactory: MailFactory) {
    const mailHandler = mailFactory.getHandler(integration, mailData.from);

    try {
      await mailHandler.send(mailData);
    } catch (error) {
      throw new ApiException(`Unexpected provider error`);
    }
  }

  private getSystemVariables(variableType: 'subscriber' | 'step' | 'branding', command: SendTestEmailCommand) {
    const variables = {};
    for (const variable in command.payload) {
      const [type, names] = variable.includes('.') ? variable.split('.') : variable;
      if (type === variableType) {
        variables[names] = command.payload[variable];
      }
    }

    return variables;
  }
}
