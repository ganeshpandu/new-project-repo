import {
  Controller,
  Post,
  Body,
  Res,
  HttpStatus,
  Get,
  Param,
  Put,
  Delete,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { TechvLogger } from 'techvedika-logger';
import { ListItemsService } from './list-items.service';
import { RESPONSE_STATUS, LogType, MethodNames } from '../../constants';
import {
  CreateListItemDto,
  CreateListItemsBulkDto,
  ListItemFilterDto,
  UpdateListItemDto,
} from './dto/list-items.dto';
import { ListItemEntity, ListItemListEntity } from './entity/list-items.entity';
import { JwtAuthGuard } from '../guards/guards';

@ApiTags('List Items')
@Controller('listitems')
export class ListItemsController {
  constructor(
    private readonly listItemsService: ListItemsService,
    private readonly loggerInstance: TechvLogger,
  ) {}

  @Post('/')
  @ApiOperation({ summary: 'Create list item' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: RESPONSE_STATUS.LISTITEMS + RESPONSE_STATUS.SUCCESS.CREATE,
    type: ListItemEntity,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: RESPONSE_STATUS.ERROR.BAD_REQUEST,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async create(
    @Body() createListItemDto: CreateListItemDto,
    @Res() res: Response,
    @Req() req: Request & { user?: { userId: string } },
  ) {
    this.loggerInstance.logger(LogType.INFO, {
      message: 'create list item',
      data: {
        controller: ListItemsController.name,
        method: MethodNames.create,
      },
      input: createListItemDto,
    });
    try {
      const userId = req.user?.userId as string;
      const result = await this.listItemsService.create(
        createListItemDto,
        userId,
      );
      this.loggerInstance.logger(LogType.INFO, {
        message: 'create list item successfully',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.create,
        },
        output: result,
      });
      return res.status(result.status).send(result.data);
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'create list item failed',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.create,
        },
        error:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(error);
    }
  }

  @Post('/bulk')
  @ApiOperation({ summary: 'Create list item in bulk' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: RESPONSE_STATUS.LISTITEMS + RESPONSE_STATUS.SUCCESS.CREATE,
    type: ListItemEntity,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: RESPONSE_STATUS.ERROR.BAD_REQUEST,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async createBulk(
    @Body() createListItemsBulkDto: CreateListItemsBulkDto,
    @Res() res: Response,
    @Req() req: Request & { user?: { userId: string } },
  ) {
    this.loggerInstance.logger(LogType.INFO, {
      message: 'create list item bulk',
      data: {
        controller: ListItemsController.name,
        method: MethodNames.create,
      },
      input: createListItemsBulkDto,
    });
    try {
      const userId = req.user?.userId as string;
      const result = await this.listItemsService.createBulk(
        createListItemsBulkDto,
        userId,
      );
      this.loggerInstance.logger(LogType.INFO, {
        message: 'create list item successfully',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.create,
        },
        output: result,
      });
      return res.status(result.status).send(result.data);
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'create list item failed',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.create,
        },
        error:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(error);
    }
  }

  @Post('all')
  @ApiOperation({ summary: 'Get all list items' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: RESPONSE_STATUS.LISTITEMS + RESPONSE_STATUS.SUCCESS.FIND_ALL,
    type: ListItemListEntity,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: RESPONSE_STATUS.ERROR.BAD_REQUEST,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async findAll(
    @Body() listItemFilterDto: ListItemFilterDto,
    @Res() res: Response,
  ) {
    this.loggerInstance.logger(LogType.INFO, {
      message: 'find all list items',
      data: {
        controller: ListItemsController.name,
        method: MethodNames.findAll,
      },
      input: listItemFilterDto,
    });
    try {
      const result = await this.listItemsService.findAll(listItemFilterDto);
      this.loggerInstance.logger(LogType.INFO, {
        message: 'find all list items successfully',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.findAll,
        },
        output: result,
      });
      return res.status(result.status).send(result.data);
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'find all list items failed',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.findAll,
        },
        error:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(error);
    }
  }

  @Get('/:listItemId')
  @ApiOperation({ summary: 'Get list item by composite id' })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      RESPONSE_STATUS.LISTITEMS + RESPONSE_STATUS.SUCCESS.FIND_UNIQUE,
    type: ListItemEntity,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: RESPONSE_STATUS.ERROR.BAD_REQUEST,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async findUnique(
    @Param('listItemId') listItemId: string,
    @Res() res: Response,
  ) {
    this.loggerInstance.logger(LogType.INFO, {
      message: 'find unique list item',
      data: {
        controller: ListItemsController.name,
        method: MethodNames.findUnique,
      },
      input: { listItemId },
    });
    try {
      const result = await this.listItemsService.findUnique(listItemId);
      this.loggerInstance.logger(LogType.INFO, {
        message: 'find unique list item successfully',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.findUnique,
        },
        output: result,
      });
      return res.status(result.status).send(result.data);
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'find unique list item failed',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.findUnique,
        },
        error:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(error);
    }
  }

  @Put('/:listItemId')
  @ApiOperation({ summary: 'Update list item' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: RESPONSE_STATUS.LISTITEMS + RESPONSE_STATUS.SUCCESS.UPDATE,
    type: ListItemEntity,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: RESPONSE_STATUS.ERROR.BAD_REQUEST,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('listItemId') listItemId: string,
    @Body() updateListItemDto: UpdateListItemDto,
    @Res() res: Response,
    @Req() req: Request & { user?: { userId: string } },
  ) {
    this.loggerInstance.logger(LogType.INFO, {
      message: 'update list item',
      data: {
        controller: ListItemsController.name,
        method: MethodNames.update,
      },
      input: { listItemId, updateListItemDto },
    });
    try {
      const userId = req.user?.userId as string;
      const result = await this.listItemsService.update(
        listItemId,
        updateListItemDto,
        userId,
      );
      this.loggerInstance.logger(LogType.INFO, {
        message: 'update list item successfully',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.update,
        },
        output: result,
      });
      return res.status(result.status).send(result.data);
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'update list item failed',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.update,
        },
        error:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(error);
    }
  }

  @Delete('/:listItemId')
  @ApiOperation({ summary: 'Delete list item' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: RESPONSE_STATUS.LISTITEMS + RESPONSE_STATUS.SUCCESS.DELETE,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: RESPONSE_STATUS.ERROR.BAD_REQUEST,
  })
  @ApiResponse({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: RESPONSE_STATUS.ERROR.INTERNAL_SERVER_ERROR,
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async delete(@Param('listItemId') listItemId: string, @Res() res: Response) {
    this.loggerInstance.logger(LogType.INFO, {
      message: 'delete list item',
      data: {
        controller: ListItemsController.name,
        method: MethodNames.delete,
      },
      input: listItemId,
    });
    try {
      const result = await this.listItemsService.delete(listItemId);
      this.loggerInstance.logger(LogType.INFO, {
        message: 'delete list item successfully',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.delete,
        },
        output: result,
      });
      return res.status(result.status).send(result.data);
    } catch (error) {
      this.loggerInstance.logger(LogType.ERROR, {
        message: 'delete list item failed',
        data: {
          controller: ListItemsController.name,
          method: MethodNames.delete,
        },
        error:
          error instanceof Error
            ? error.message
            : RESPONSE_STATUS.ERROR.ERROR_OCCURRED,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(error);
    }
  }
}
