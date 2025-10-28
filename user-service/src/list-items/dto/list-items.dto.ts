import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  IsObject,
} from 'class-validator';

export class CreateListItemDto {
  @ApiProperty({
    example: 'uuid-of-list',
    description: 'Foreign key: Lists.listId',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  listId: string;

  @ApiPropertyOptional({
    example: 'uuid-of-userlist',
    description: 'Foreign key: UserLists.userListId',
  })
  @IsOptional()
  @IsString()
  userListId?: string | null;

  @ApiPropertyOptional({
    example: 'Buy milk',
    description: 'Item title (max 50 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  title?: string | null;

  @ApiPropertyOptional({
    example: '2 liters whole milk',
    description: 'Notes (max 50 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  notes?: string | null;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether item is starred',
  })
  @IsOptional()
  @IsBoolean()
  starred?: boolean;

  @ApiPropertyOptional({
    example: { priority: 'high', startTime: '2025-10-22T12:00:00', endTime: '2025-10-22T12:00:00' },
    description: 'Arbitrary attributes as JSON',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, any> | null;

  @ApiPropertyOptional({
    example: { title: 'string' },
    description: 'Attribute data types as JSON',
  })
  @IsOptional()
  @IsObject()
  attributeDataType?: Record<string, any> | null;

  @ApiPropertyOptional({
    example: { qty: 'pcs' },
    description: 'Units as JSON',
  })
  @IsOptional()
  @IsObject()
  unit?: Record<string, any> | null;
}

export class UpdateListItemDto extends PartialType(CreateListItemDto) {}

export class CreateListItemsBulkDto {
  @ApiProperty({ type: [CreateListItemDto] })
  items!: CreateListItemDto[];
}

export class ListItemFilterDto {
  @ApiPropertyOptional({
    example: 'uuid-of-userlist',
    description: 'Filter by userListId',
  })
  @IsOptional()
  @IsString()
  userListId?: string;

  @ApiPropertyOptional({
    example: 'uuid-of-list',
    description: 'Filter by listId',
  })
  @IsOptional()
  @IsString()
  listId?: string;

  @ApiPropertyOptional({ example: true, description: 'Filter by starred' })
  @IsOptional()
  @IsBoolean()
  starred?: boolean;

  @ApiPropertyOptional({
    example: '2025-10-22T12:00:00',
    description: 'Filter by startTime',
  })
  @IsOptional()
  @IsString()
  startTime?: string | null;

  @ApiPropertyOptional({
    example: '2025-10-22T12:00:00',
    description: 'Filter by endTime',
  })
  @IsOptional()
  @IsString()
  endTime?: string | null;

  @ApiPropertyOptional({
    example: 1,
    description: 'Page number for pagination',
  })
  @IsOptional()
  @IsNumber()
  pageNumber?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Items per page for pagination',
  })
  @IsOptional()
  @IsNumber()
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}
