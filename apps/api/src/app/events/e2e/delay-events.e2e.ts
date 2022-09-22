import {
  MessageRepository,
  NotificationTemplateEntity,
  SubscriberEntity,
  JobRepository,
  JobStatusEnum,
} from '@novu/dal';
import { UserSession, SubscribersService } from '@novu/testing';

import { expect } from 'chai';
import { StepTypeEnum, DigestTypeEnum, DigestUnitEnum } from '@novu/shared';
import axios from 'axios';
import { WorkflowQueueService } from '../services/workflow.queue.service';

const axiosInstance = axios.create();

describe('Trigger event - Delay triggered events - /v1/events/trigger (POST)', function () {
  let session: UserSession;
  let template: NotificationTemplateEntity;
  let subscriber: SubscriberEntity;
  let subscriberService: SubscribersService;
  const jobRepository = new JobRepository();
  let workflowQueueService: WorkflowQueueService;
  const messageRepository = new MessageRepository();

  const awaitRunningJobs = async (unfinishedJobs = 0) => {
    let runningJobs = 0;
    do {
      runningJobs = await jobRepository.count({
        type: {
          $nin: [StepTypeEnum.DELAY],
        },
        _templateId: template._id,
        status: {
          $in: [JobStatusEnum.PENDING, JobStatusEnum.QUEUED, JobStatusEnum.RUNNING],
        },
      });
    } while (runningJobs > unfinishedJobs);
  };

  const triggerEvent = async (payload, transactionId?: string, overrides = {}) => {
    await axiosInstance.post(
      `${session.serverUrl}/v1/events/trigger`,
      {
        transactionId,
        name: template.triggers[0].identifier,
        to: [subscriber.subscriberId],
        payload,
        overrides,
      },
      {
        headers: {
          authorization: `ApiKey ${session.apiKey}`,
        },
      }
    );
  };

  beforeEach(async () => {
    session = new UserSession();
    await session.initialize();
    template = await session.createTemplate();
    subscriberService = new SubscribersService(session.organization._id, session.environment._id);
    subscriber = await subscriberService.createSubscriber();
    workflowQueueService = session.testServer.getService(WorkflowQueueService);
  });

  it('should delay event for time interval', async function () {
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Not Delayed {{customVar}}' as string,
        },
        {
          type: StepTypeEnum.DELAY,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
      ],
    });

    await triggerEvent({
      customVar: 'Testing of User Name',
    });

    await awaitRunningJobs(1);

    const delayedJob = await jobRepository.findOne({
      _templateId: template._id,
      type: StepTypeEnum.DELAY,
    });

    expect(delayedJob.status).to.equal(JobStatusEnum.DELAYED);

    const messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.SMS,
    });

    expect(messages.length).to.equal(1);
    expect(messages[0].content).to.include('Not Delayed');

    await workflowQueueService.work(delayedJob);
    await awaitRunningJobs(0);

    const messagesAfter = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.SMS,
    });

    expect(messagesAfter.length).to.equal(2);
  });

  it('should override delay parameters', async function () {
    const id = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.DELAY,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
      ],
    });

    await triggerEvent(
      {
        customVar: 'Testing of User Name',
      },
      id,
      { delay: { amount: 3, unit: DigestUnitEnum.SECONDS } }
    );
    await awaitRunningJobs(0);
    const messages = await messageRepository.find({
      _environmentId: session.environment._id,
      _subscriberId: subscriber._id,
      channel: StepTypeEnum.SMS,
    });

    expect(messages.length).to.equal(1);
  });

  it('should be able to cancel delay', async function () {
    const id = MessageRepository.createObjectId();
    template = await session.createTemplate({
      steps: [
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
        {
          type: StepTypeEnum.DELAY,
          content: '',
          metadata: {
            unit: DigestUnitEnum.MINUTES,
            amount: 5,
            type: DigestTypeEnum.REGULAR,
          },
        },
        {
          type: StepTypeEnum.SMS,
          content: 'Hello world {{customVar}}' as string,
        },
      ],
    });

    await triggerEvent(
      {
        customVar: 'Testing of User Name',
      },
      id
    );

    await awaitRunningJobs(1);
    await axiosInstance.delete(`${session.serverUrl}/v1/events/trigger/${id}`, {
      headers: {
        authorization: `ApiKey ${session.apiKey}`,
      },
    });

    let delayedJob = await jobRepository.findOne({
      _templateId: template._id,
      type: StepTypeEnum.DELAY,
    });

    await workflowQueueService.work(delayedJob);

    const pendingJobs = await jobRepository.count({
      _templateId: template._id,
      status: JobStatusEnum.PENDING,
      transactionId: id,
    });

    expect(pendingJobs).to.equal(1);

    delayedJob = await jobRepository.findOne({
      _templateId: template._id,
      type: StepTypeEnum.DELAY,
      transactionId: id,
    });
    expect(delayedJob.status).to.equal(JobStatusEnum.CANCELED);
  });
});
