import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '@traeta/prisma';
import { TechvLogger } from 'techvedika-logger';
import {
  LogType,
  MethodNames,
  RESPONSE_STATUS,
  Response,
  ACTIVE_CONDITION,
  REC_SEQ,
  REC_STATUS,
  ADMIN,
  DB_NAME,
  TABLE_NAMES,
} from '../../constants';
import {
  CreateUserListDto,
  UpdateUserListDto,
  UserListFilterDto,
} from './dto/user-lists.dto';
import { UtilityService } from '../utility/utility.service';

@Injectable()
export class UserListsService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly loggerInstance: TechvLogger,
    private readonly utilityService: UtilityService,
  ) {}

  async create(dto: CreateUserListDto, userId: string): Promise<Response<any>> {
    const response: Response<any> = {
      status: HttpStatus.CREATED,
      data: '',
    };

    this.loggerInstance.logger(LogType.INFO, {
      message: 'create user list',
      data: {
        service: UserListsService.name,
        method: MethodNames.create,
      },
      input: dto,
    });

    try {
      const created = await this.prismaService.$transaction(async (tx) => {
        // Check for duplicate user list
        const existing = await tx.userLists.findFirst({
          where: {
            userId,
            listId: dto.listId,
            ...ACTIVE_CONDITION,
          },
        });

        if (existing) {
          this.loggerInstance.logger(LogType.ERROR, {
            message: 'user list already exists',
            data: {
              service: UserListsService.name,
              method: MethodNames.create,
            },
            input: dto,
          });
          throw new Error(RESPONSE_STATUS.ERROR.ALREADY_EXISTS);
        }

        const userList = await tx.userLists.create({
          data: {
            userId,
            userRecSeq: REC_SEQ.DEFAULT_RECORD,
            listId: dto.listId,
            listRecSeq: REC_SEQ.DEFAULT_RECORD,
            customName: dto.customName ?? null,
            createdBy: userId,
            ...ACTIVE_CONDITION,
          },
        });

        // Create integrations if any
        if (dto.integrations?.length) {
          await tx.userListIntegrations.createMany({
            data: dto.integrations.map((i) => ({
              userListId: userList.userListId,
              userListRecSeq: userList.recSeq,
              integrationId: i.integrationId,
              integrationRecSeq: REC_SEQ.DEFAULT_RECORD,
              status: i.status,
              connectedAt: i.connectedAt ? new Date(i.connectedAt) : null,
            })),
          });
        }

        // Return created record with relations
        return await tx.userLists.findUnique({
          where: {
            userListId_recSeq: {
              userListId: userList.userListId,
              recSeq: userList.recSeq,
            },
          },
          include: { integrations: true },
        });
      });

      response.data = created;

      this.loggerInstance.logger(LogType.INFO, {
        message: 'create user list successfully',
        data: {
          service: UserListsService.name,
          method: MethodNames.create,
        },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'create user list failed',
        data: {
          service: UserListsService.name,
          method: MethodNames.create,
        },
        error:
          error instanceof Error
            ? { message: error.message }
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return {
        status:
          error instanceof Error &&
          error.message === RESPONSE_STATUS.ERROR.ALREADY_EXISTS
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.INTERNAL_SERVER_ERROR,
        data:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
      };
    }
  }

  async findAll(
    userListFilterDto: UserListFilterDto,
    userId: string,
  ): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };
    const metadata = { pageNumber: 1, limit: 10, totalCount: 0 };

    this.loggerInstance.logger(LogType.INFO, {
      message: 'find all user lists',
      data: {
        service: UserListsService.name,
        method: MethodNames.findAll,
      },
      input: userListFilterDto,
    });

    try {
      const { pageNumber, limit, search } = userListFilterDto;
      const skip = pageNumber && limit ? (pageNumber - 1) * limit : 0;

      const filterConditions = this.utilityService.buildFilter(
        userListFilterDto,
        ['pageNumber', 'limit', 'search'],
      );

      let searchCondition = {};
      if (search && search.trim().length > 0) {
        searchCondition = {
          OR: [
            {
              customName: {
                contains: search,
                mode: 'insensitive',
              },
            },
          ],
        };
      }

      const whereCondition = {
        AND: [filterConditions, searchCondition, ACTIVE_CONDITION],
      };

      const [userLists, totalCount] = await Promise.all([
        this.prismaService.userLists
          .findMany({
            where: { ...whereCondition, userId, list: { ...ACTIVE_CONDITION } },
            skip,
            take: limit,
            include: {
              list: {
                select: {
                  listId: true,
                  name: true,
                },
              },
              integrations: {
                select: {
                  integrationId: true,
                  integration: {
                    select: {
                      name: true,
                      label: true,
                    },
                  },
                  status: true,
                  connectedAt: true,
                },
                where: {
                  ...ACTIVE_CONDITION,
                },
              },
              _count: {
                select: {
                  ListItems: {
                    where: {
                      ...ACTIVE_CONDITION,
                    },
                  },
                },
              },
            },
          })
          .then((lists) =>
            lists.map((item) => ({
              ...item,
              list: {
                listId: item.list.listId,
                predefinedList: item.list.name,
                listItemsCount: item._count.ListItems,
              },
            })),
          ),
        this.prismaService.userLists.count({ where: whereCondition }),
      ]);

      Object.assign(metadata, { pageNumber, limit, totalCount });
      response.data = { data: userLists, metadata };

      this.loggerInstance.logger(LogType.INFO, {
        message: 'find all user lists successfully',
        data: {
          service: UserListsService.name,
          method: MethodNames.findAll,
        },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'find all user lists failed',
        data: {
          service: UserListsService.name,
          method: MethodNames.findAll,
        },
        error:
          error instanceof Error
            ? { message: error.message }
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        data: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
      };
    }
  }

  async findUnique(userListId: string, userId: string): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };

    this.loggerInstance.logger(LogType.INFO, {
      message: 'find unique user list',
      data: {
        service: UserListsService.name,
        method: MethodNames.findUnique,
      },
      input: userListId,
    });

    try {
      const result = await this.prismaService.userLists.findUnique({
        where: {
          userListId_recSeq: {
            userListId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          userId,
        },
        include: {
          integrations: {
            select: {
              integrationId: true,
              status: true,
              connectedAt: true,
            },
            where: {
              ...ACTIVE_CONDITION,
            },
          },
        },
      });

      response.data = result;

      this.loggerInstance.logger(LogType.INFO, {
        message: 'find unique user list successfully',
        data: {
          service: UserListsService.name,
          method: MethodNames.findUnique,
        },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'find unique user list failed',
        data: {
          service: UserListsService.name,
          method: MethodNames.findUnique,
        },
        error:
          error instanceof Error
            ? { message: error.message }
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });

      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        data: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
      };
    }
  }

  async update(
    userListId: string,
    update: UpdateUserListDto,
    userId: string,
  ): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };

    this.loggerInstance.logger(LogType.INFO, {
      message: 'update user list',
      data: {
        service: UserListsService.name,
        method: MethodNames.update,
      },
      input: { userListId, update },
    });

    try {
      const existing = await this.prismaService.userLists.findUnique({
        where: {
          userListId_recSeq: {
            userListId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          userId,
        },
      });

      if (!existing) {
        return {
          status: HttpStatus.NOT_FOUND,
          data: RESPONSE_STATUS.ERROR.NOT_FOUND,
        };
      }

      const { integrations, ...safeUpdate } = update;

      if (integrations && integrations.length > 0) {
        for (const integration of integrations) {
          await this.utilityService.updateEntity({
            dbname: DB_NAME,
            tablename: TABLE_NAMES.USER_LISTS_INTEGRATIONS,
            updateData: { ...integration, modifiedBy: userId },
            primaryKeyCriteria: { userListId },
            requestId: userId,
            username: userId,
          });
        }
      }

      const updated = await this.utilityService.updateEntity({
        dbname: DB_NAME,
        tablename: TABLE_NAMES.USER_LISTS,
        updateData: { ...safeUpdate, modifiedBy: ADMIN },
        primaryKeyCriteria: { userListId },
        requestId: ADMIN,
        username: ADMIN,
      });

      response.data = updated;

      this.loggerInstance.logger(LogType.INFO, {
        message: 'update user list successfully',
        data: {
          service: UserListsService.name,
          method: MethodNames.update,
        },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'update user list failed',
        data: {
          service: UserListsService.name,
          method: MethodNames.update,
        },
        error:
          error instanceof Error
            ? { message: error.message }
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });

      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        data: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
      };
    }
  }

  async delete(userListId: string, userId: string): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };

    this.loggerInstance.logger(LogType.INFO, {
      message: 'delete user list',
      data: {
        service: UserListsService.name,
        method: MethodNames.delete,
      },
      input: userListId,
    });

    try {
      const existing = await this.prismaService.userLists.findUnique({
        where: {
          userListId_recSeq: {
            userListId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          userId,
        },
      });

      if (!existing) {
        return {
          status: HttpStatus.NOT_FOUND,
          data: RESPONSE_STATUS.ERROR.NOT_FOUND,
        };
      }

      await this.prismaService.userLists.update({
        where: {
          userListId_recSeq: {
            userListId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          userId,
        },
        data: { recStatus: REC_STATUS.INACTIVE },
      });

      response.data = RESPONSE_STATUS.SUCCESS.DELETE;

      this.loggerInstance.logger(LogType.INFO, {
        message: 'delete user list successfully',
        data: {
          service: UserListsService.name,
          method: MethodNames.delete,
        },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'delete user list failed',
        data: {
          service: UserListsService.name,
          method: MethodNames.delete,
        },
        error:
          error instanceof Error
            ? { message: error.message }
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });

      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        data: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
      };
    }
  }
}
