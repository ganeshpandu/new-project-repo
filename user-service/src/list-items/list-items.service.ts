import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '@traeta/prisma';
import { TechvLogger } from 'techvedika-logger';
import { UtilityService } from '../utility/utility.service';
import {
  ACTIVE_CONDITION,
  DB_NAME,
  LogType,
  MethodNames,
  REC_SEQ,
  REC_STATUS,
  RESPONSE_STATUS,
  Response,
  TABLE_NAMES,
  Metadata,
} from '../../constants';
import {
  CreateListItemDto,
  ListItemFilterDto,
  UpdateListItemDto,
  CreateListItemsBulkDto,
} from './dto/list-items.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ListItemsService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly loggerInstance: TechvLogger,
    private readonly utilityService: UtilityService,
  ) {}

  async create(
    createDto: CreateListItemDto,
    userId: string,
  ): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.CREATED, data: '' };
    this.loggerInstance.logger(LogType.INFO, {
      message: 'create list item',
      data: { service: ListItemsService.name, method: MethodNames.create },
      input: createDto,
    });

    try {
      const existingRecord = await this.prismaService.listItems.findFirst({
        where: {
          listId: createDto.listId,
          userListId: createDto.userListId,
          attributes:
            createDto.attributes === null
              ? { equals: Prisma.JsonNull }
              : createDto.attributes === undefined
              ? undefined
              : { equals: createDto.attributes },
          ...ACTIVE_CONDITION,
        },
      });

      if (existingRecord) {
        this.loggerInstance.logger(LogType.ERROR, {
          message: 'create list item failed - already exists',
          data: { service: ListItemsService.name, method: MethodNames.create },
          input: createDto,
        });
        return {
          status: HttpStatus.BAD_REQUEST,
          data: RESPONSE_STATUS.ERROR.ALREADY_EXISTS,
        };
      }

      const list = await this.prismaService.lists.findFirst({
        where: { listId: createDto.listId, ...ACTIVE_CONDITION },
      });

      if (createDto.attributes) {
        const attrs = createDto.attributes as Record<string, any>;
        for (const key of ['startTime', 'endTime'] as const) {
          const v = attrs[key];
          if (v) {
            const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
            if (d && !isNaN(d.getTime())) {
              attrs[key] = this.utilityService.formatDateTimeToUtc(d);
            }
          }
        }
      }

      const attrs = createDto.attributes ?? {};
      const listName = (list?.name ?? '').toLowerCase();

      const inferredCategory: string | null = this.utilityService.inferCategory(
        listName,
        attrs,
      );

      let resolvedCategory:
        | { itemCategoryId: string; recSeq: number }
        | undefined;
      if (inferredCategory) {
        const category = await this.prismaService.itemCategories.findFirst({
          where: {
            listId: createDto.listId,
            name: { equals: inferredCategory.replace('_', ' '), mode: 'insensitive' },
            ...ACTIVE_CONDITION,
          },
        });
        if (category) {
          resolvedCategory = {
            itemCategoryId: category.itemCategoryId,
            recSeq: category.recSeq,
          };
        }
      }

      const data: Prisma.ListItemsUncheckedCreateInput = {
        ...createDto,
        title:
          createDto.title ??
          (inferredCategory ? `${inferredCategory}` : (list?.name ?? null)),
        attributes:
          createDto.attributes === null
            ? Prisma.JsonNull
            : createDto.attributes,
        attributeDataType:
          createDto.attributeDataType === null
            ? Prisma.JsonNull
            : createDto.attributeDataType,
        unit: createDto.unit === null ? Prisma.JsonNull : createDto.unit,
        ...ACTIVE_CONDITION,
        createdBy: userId,
      };

      if (resolvedCategory) {
        data.categoryId = resolvedCategory.itemCategoryId;
        data.categoryRecSeq = REC_SEQ.DEFAULT_RECORD;
      }

      const result = await this.prismaService.listItems.create({ data });

      response.data = result;
      this.loggerInstance.logger(LogType.INFO, {
        message: 'create list item successfully',
        data: { service: ListItemsService.name, method: MethodNames.create },
        output: response,
      });
      return response;
    } catch (error) {
      console.log(error);
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'create list item failed',
        data: { service: ListItemsService.name, method: MethodNames.create },
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

  private async buildCreateData(
    prisma: PrismaService | Prisma.TransactionClient,
    createDto: CreateListItemDto,
    userId: string,
  ): Promise<{
    data: Prisma.ListItemsUncheckedCreateInput | null;
    duplicate: boolean;
  }> {
    const existingRecord = await prisma.listItems.findFirst({
      where: {
        title: createDto.title,
        listId: createDto.listId,
        userListId: createDto.userListId,
        ...ACTIVE_CONDITION,
      },
    });
    if (existingRecord) return { data: null, duplicate: true };

    const list = await prisma.lists.findFirst({
      where: { listId: createDto.listId, ...ACTIVE_CONDITION },
    });

    if (createDto.attributes) {
      const attrs = createDto.attributes as Record<string, any>;
      for (const key of ['startTime', 'endTime'] as const) {
        const v = attrs[key];
        if (v) {
          const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
          if (d && !isNaN(d.getTime())) {
            attrs[key] = this.utilityService.formatDateTimeToUtc(d);
          }
        }
      }
    }
    
    const attrs = createDto.attributes ?? {};
    const listName = (list?.name ?? '').toLowerCase();

    const inferredCategory: string | null = this.utilityService.inferCategory(
      listName,
      attrs,
    );

    const baseData: Prisma.ListItemsUncheckedCreateInput = {
      ...createDto,
      title:
        createDto.title ??
        (inferredCategory ? `${inferredCategory}` : (list?.name ?? null)),
      attributes:
        createDto.attributes === null ? Prisma.JsonNull : createDto.attributes,
      attributeDataType:
        createDto.attributeDataType === null
          ? Prisma.JsonNull
          : createDto.attributeDataType,
      unit: createDto.unit === null ? Prisma.JsonNull : createDto.unit,
      ...ACTIVE_CONDITION,
      createdBy: userId,
    };

    let finalData: Prisma.ListItemsUncheckedCreateInput = baseData;

    if (inferredCategory) {
      const category = await prisma.itemCategories.findFirst({
        where: {
          listId: createDto.listId,
          name: { equals: inferredCategory.replace('_', ' '), mode: 'insensitive' },
          ...ACTIVE_CONDITION,
        },
      });
      if (category) {
        finalData = {
          ...baseData,
          categoryId: category.itemCategoryId,
          categoryRecSeq: category.recSeq,
        };
      }
    }

    return { data: finalData, duplicate: false };
  }

  async createBulk(
    bulkDto: CreateListItemsBulkDto,
    userId: string,
  ): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.CREATED, data: '' };
    this.loggerInstance.logger(LogType.INFO, {
      message: 'bulk create list items',
      data: { service: ListItemsService.name, method: 'createBulk' },
      input: { count: bulkDto.items?.length ?? 0 },
    });

    try {
      const created: unknown[] = [];
      let skipped = 0;

      await this.prismaService.$transaction(
        async (tx: Prisma.TransactionClient) => {
          for (const item of bulkDto.items ?? []) {
            const { data, duplicate } = await this.buildCreateData(
              tx,
              item,
              userId,
            );
            if (duplicate || !data) {
              skipped++;
              continue;
            }
            const res = await tx.listItems.create({ data });
            created.push(res);
          }
        },
      );

      response.data = {
        createdCount: created.length,
        skippedCount: skipped,
        items: created,
      };
      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'bulk create list items failed',
        data: { service: ListItemsService.name, method: 'createBulk' },
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

  async findAll(filterDto: ListItemFilterDto): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };
    const metadata: Metadata = { pageNumber: 1, limit: 1, totalCount: 0 };

    this.loggerInstance.logger(LogType.INFO, {
      message: 'find all list items',
      data: { service: ListItemsService.name, method: MethodNames.findAll },
      input: filterDto,
    });

    try {
      const { pageNumber, limit, search } = filterDto;
      const skip = pageNumber && limit ? (pageNumber - 1) * limit : 0;

      const filterConditions = this.utilityService.buildFilter(filterDto, [
        'pageNumber',
        'limit',
        'search',
        'startTime',
        'endTime',
      ]);

      let searchCondition = {};
      if (search && search.trim().length > 0) {
        searchCondition = {
          title: {
            contains: search,
            mode: 'insensitive',
          },
        };
      }

      const startTimeCondition = filterDto.startTime
        ? {
            createdAt: {
              gte: filterDto.startTime,
            },
          }
        : {};
      const endTimeCondition = filterDto.endTime
        ? {
            createdAt: {
              lte: filterDto.endTime,
            },            
          }
        : {};

      const whereCondition = {
        AND: [filterConditions, searchCondition, startTimeCondition, endTimeCondition, ACTIVE_CONDITION],
      };

      const [listItems, totalCount] = await Promise.all([
        this.prismaService.listItems.findMany({
          where: whereCondition,
          include: {
            userList: {
              select: {
                customName: true,
              },
            },
            list: {
              select: {
                name: true,
              },
            },
            category: {
              select: {
                name: true,
              },
            },
          },
          skip,
          take: limit,
        }),
        this.prismaService.listItems.count({ where: whereCondition }),
      ]);

      Object.assign(metadata, { limit, pageNumber, totalCount });

      const hasCategories = (listItems as any[]).some(
        (it) => it?.category?.name && String(it.category.name).trim().length > 0,
      );

      if (hasCategories) {
        const grouped: Record<string, any[]> = {};
        for (const item of listItems as any[]) {
          const key = item?.category?.name || item?.title || 'Uncategorized';
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(item);
        }
        response.data = { data: [grouped], metadata };
      } else {
        response.data = { data: listItems, metadata };
      }

      this.loggerInstance.logger(LogType.INFO, {
        message: 'find all list items successfully',
        data: { service: ListItemsService.name, method: MethodNames.findAll },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'find all list items failed',
        data: { service: ListItemsService.name, method: MethodNames.findAll },
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

  async findUnique(listItemId: string): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };
    this.loggerInstance.logger(LogType.INFO, {
      message: 'find unique list item',
      data: { service: ListItemsService.name, method: MethodNames.findUnique },
      input: { listItemId },
    });

    try {
      const result = await this.prismaService.listItems.findUnique({
        where: {
          listItemId_recSeq: { listItemId, recSeq: REC_SEQ.DEFAULT_RECORD },
          ...ACTIVE_CONDITION,
        },
      });

      response.data = result;
      this.loggerInstance.logger(LogType.INFO, {
        message: 'find unique list item successfully',
        data: {
          service: ListItemsService.name,
          method: MethodNames.findUnique,
        },
        output: response,
      });
      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'find unique list item failed',
        data: {
          service: ListItemsService.name,
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
    listItemId: string,
    updateDto: UpdateListItemDto,
    userId: string,
  ): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };
    this.loggerInstance.logger(LogType.INFO, {
      message: 'update list item',
      data: { service: ListItemsService.name, method: MethodNames.update },
      input: { listItemId, updateDto },
    });

    try {
      const existingRecord = await this.prismaService.listItems.findUnique({
        where: {
          listItemId_recSeq: {
            listItemId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          ...ACTIVE_CONDITION,
        },
      });

      if (!existingRecord) {
        this.loggerInstance.logger(LogType.ERROR, {
          message: 'update list item failed - not found',
          data: { service: ListItemsService.name, method: MethodNames.update },
          input: listItemId,
        });
        return {
          status: HttpStatus.NOT_FOUND,
          data: RESPONSE_STATUS.ERROR.NOT_FOUND,
        };
      }

      const updatedStatus = await this.utilityService.updateEntity({
        dbname: DB_NAME,
        tablename: TABLE_NAMES.LIST_ITEMS,
        updateData: { ...updateDto, modifiedBy: userId },
        primaryKeyCriteria: { listItemId },
        requestId: userId,
        username: userId,
      });

      response.data = updatedStatus;
      this.loggerInstance.logger(LogType.INFO, {
        message: 'update list item successfully',
        data: { service: ListItemsService.name, method: MethodNames.update },
        output: response,
      });
      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'update list item failed',
        data: { service: ListItemsService.name, method: MethodNames.update },
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

  async delete(listItemId: string): Promise<Response<any>> {
    const response: Response<any> = { status: HttpStatus.OK, data: '' };
    this.loggerInstance.logger(LogType.INFO, {
      message: 'delete list item',
      data: { service: ListItemsService.name, method: MethodNames.delete },
      input: listItemId,
    });

    try {
      const existingRecord = await this.prismaService.listItems.findUnique({
        where: {
          listItemId_recSeq: {
            listItemId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          ...ACTIVE_CONDITION,
        },
      });

      if (!existingRecord) {
        this.loggerInstance.logger(LogType.ERROR, {
          message: 'delete list item failed - not found',
          data: { service: ListItemsService.name, method: MethodNames.delete },
          input: listItemId,
        });
        return {
          status: HttpStatus.NOT_FOUND,
          data: RESPONSE_STATUS.ERROR.NOT_FOUND,
        };
      }

      await this.prismaService.listItems.update({
        where: {
          listItemId_recSeq: {
            listItemId,
            recSeq: REC_SEQ.DEFAULT_RECORD,
          },
          ...ACTIVE_CONDITION,
        },
        data: { recStatus: REC_STATUS.INACTIVE },
      });

      response.data = RESPONSE_STATUS.SUCCESS.DELETE;
      this.loggerInstance.logger(LogType.INFO, {
        message: 'delete list item successfully',
        data: { service: ListItemsService.name, method: MethodNames.delete },
        output: response,
      });

      return response;
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'delete list item failed',
        data: { service: ListItemsService.name, method: MethodNames.delete },
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
